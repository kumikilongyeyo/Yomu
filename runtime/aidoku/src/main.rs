use std::{collections::HashMap, io::{Cursor, Read}, sync::Arc, time::Duration};

use aidoku::{Chapter, ContentRating, FilterValue, Manga, MangaStatus, Page, PageContent, Viewer};
use aidoku_test_runner::{imports, libs::{StoreItem, WasmEnv}};
use anyhow::{anyhow, bail, Context, Result};
use axum::{
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::RwLock;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use wasmer::{FunctionEnv, Instance, Module, Store};

const AIDOKU_REV: &str = "e1320b0a2e11afb59e4dee374883a2212d325699";

#[derive(Clone)]
struct AppState {
    client: reqwest::Client,
    token: Option<String>,
    packages: Arc<RwLock<HashMap<String, Arc<CachedPackage>>>>,
}

#[derive(Clone)]
struct CachedPackage {
    wasm: Arc<Vec<u8>>,
    source_json: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Implementation {
    ecosystem: String,
    store: Option<String>,
    store_id: String,
    name: String,
    id: Option<String>,
    version: Option<String>,
    base_url: String,
    artifact: Option<String>,
    language: Option<String>,
    runtime_hint: String,
    content_rating: Option<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveRequest {
    target_url: String,
    implementations: Vec<Implementation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceSpec {
    implementation: Implementation,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChapterRef {
    manga: Manga,
    chapter: Chapter,
}

#[derive(Debug, Deserialize)]
struct SearchPage {
    entries: Vec<Manga>,
    has_next_page: bool,
}

struct AidokuVm {
    store: Store,
    env: FunctionEnv<WasmEnv>,
    instance: Instance,
}

impl AidokuVm {
    fn new(wasm: &[u8]) -> Result<Self> {
        let mut store = Store::default();
        let module = Module::new(&store, wasm).context("failed to compile Aidoku WASM")?;
        let env = FunctionEnv::new(&mut store, WasmEnv::new());
        let imports = imports::generate_imports(&mut store, &env);
        let instance = Instance::new(&mut store, &module, &imports).context("failed to instantiate Aidoku source")?;
        {
            let env_mut = env.as_mut(&mut store);
            env_mut.memory = Some(instance.exports.get_memory("memory")?.clone());
        }
        let start = instance.exports.get_typed_function::<(), ()>(&store, "start")?;
        start.call(&mut store).context("Aidoku source start() failed")?;
        Ok(Self { store, env, instance })
    }

    fn decode_result<T: DeserializeOwned>(&mut self, ptr: i32) -> Result<T> {
        if ptr <= 0 {
            bail!("Aidoku source returned error code {ptr}");
        }
        let head = self.env.as_ref(&self.store).read_bytes(&self.store, ptr as u32, 4)?;
        let len = i32::from_le_bytes(head.try_into().map_err(|_| anyhow!("invalid result header"))?);
        if len == -1 {
            let meta = self.env.as_ref(&self.store).read_bytes(&self.store, ptr as u32, 12)?;
            let total = i32::from_le_bytes(meta[8..12].try_into().map_err(|_| anyhow!("invalid error header"))?);
            let message = if total > 12 {
                String::from_utf8_lossy(&self.env.as_ref(&self.store).read_bytes(&self.store, ptr as u32 + 12, (total - 12) as u32)?).to_string()
            } else {
                "Aidoku source returned an error".to_string()
            };
            self.free_result(ptr);
            bail!(message);
        }
        if len < 8 {
            self.free_result(ptr);
            bail!("Aidoku source returned a malformed result");
        }
        let payload = self.env.as_ref(&self.store).read_bytes(&self.store, ptr as u32 + 8, (len - 8) as u32)?;
        self.free_result(ptr);
        postcard::from_bytes(&payload).map_err(|e| anyhow!("failed to decode Aidoku result: {e}"))
    }

    fn free_result(&mut self, ptr: i32) {
        if let Ok(free) = self.instance.exports.get_typed_function::<i32, ()>(&self.store, "free_result") {
            let _ = free.call(&mut self.store, ptr);
        }
    }

    fn search(&mut self, query: Option<&str>, page: i32) -> Result<SearchPage> {
        let query_rid = self.env.as_mut(&mut self.store).store.store(StoreItem::String(query.unwrap_or_default().to_string()));
        let filters: Vec<FilterValue> = Vec::new();
        let filters_rid = self.env.as_mut(&mut self.store).store.store_encoded(&filters)?;
        let function = self.instance.exports.get_typed_function::<(i32, i32, i32), i32>(&self.store, "get_search_manga_list")?;
        let ptr = function.call(&mut self.store, query_rid, page.max(1), filters_rid)?;
        self.env.as_mut(&mut self.store).store.remove(query_rid);
        self.env.as_mut(&mut self.store).store.remove(filters_rid);
        self.decode_result(ptr)
    }

    fn update_manga(&mut self, manga: Manga) -> Result<Manga> {
        let rid = self.env.as_mut(&mut self.store).store.store_encoded(&manga)?;
        let function = self.instance.exports.get_typed_function::<(i32, i32, i32), i32>(&self.store, "get_manga_update")?;
        let ptr = function.call(&mut self.store, rid, 1, 1)?;
        self.env.as_mut(&mut self.store).store.remove(rid);
        self.decode_result(ptr)
    }

    fn pages(&mut self, manga: Manga, chapter: Chapter) -> Result<Vec<Page>> {
        let manga_rid = self.env.as_mut(&mut self.store).store.store_encoded(&manga)?;
        let chapter_rid = self.env.as_mut(&mut self.store).store.store_encoded(&chapter)?;
        let function = self.instance.exports.get_typed_function::<(i32, i32), i32>(&self.store, "get_page_list")?;
        let ptr = function.call(&mut self.store, manga_rid, chapter_rid)?;
        self.env.as_mut(&mut self.store).store.remove(manga_rid);
        self.env.as_mut(&mut self.store).store.remove(chapter_rid);
        self.decode_result(ptr)
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let token = std::env::var("YOMU_RUNTIME_TOKEN").ok().filter(|x| !x.trim().is_empty());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .user_agent(format!("Yomu-Aidoku-Runtime/7.0 aidoku-rs/{AIDOKU_REV}"))
        .build()?;
    let state = AppState { client, token, packages: Arc::new(RwLock::new(HashMap::new())) };
    let app = Router::new()
        .route("/healthz", get(health))
        .route("/v1/resolve", post(resolve))
        .route("/v1/source/{source_id}/{*rest}", get(source_api))
        .with_state(state)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());
    let port: u16 = std::env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8080);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    println!("Yomu Aidoku runtime listening on {port}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true, "version": "7.0", "engine": "aidoku-wasm", "aidokuRev": AIDOKU_REV }))
}

fn authorized(headers: &HeaderMap, state: &AppState) -> bool {
    let Some(expected) = state.token.as_ref() else { return true; };
    headers.get("authorization").and_then(|v| v.to_str().ok()) == Some(&format!("Bearer {expected}"))
}

async fn resolve(State(state): State<AppState>, headers: HeaderMap, Json(request): Json<ResolveRequest>) -> impl IntoResponse {
    if !authorized(&headers, &state) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"ok": false, "error": "Unauthorized runtime broker request."}))).into_response();
    }

    let mut attempts = Vec::new();
    for implementation in request.implementations.into_iter().filter(|x| x.ecosystem == "aidoku" && x.runtime_hint == "aidoku-wasm").take(4) {
        let spec = SourceSpec { implementation };
        match load_package(&state, &spec).await {
            Ok(package) => {
                let probe_package = package.clone();
                let probe = tokio::task::spawn_blocking(move || probe_source(&probe_package)).await;
                match probe {
                    Ok(Ok(probe)) => {
                        let source_id = encode_json(&spec).unwrap_or_default();
                        let implementation = &spec.implementation;
                        let adapter = json!({
                            "id": format!("fabric-aidoku-{}", slug(implementation.id.as_deref().unwrap_or(&implementation.name))),
                            "name": implementation.name,
                            "version": implementation.version.as_deref().and_then(|v| v.parse::<u64>().ok()).unwrap_or(1),
                            "language": implementation.language.as_deref().and_then(|v| v.split(',').next()).unwrap_or("en"),
                            "content": ["manga", "manhwa", "manhua", "webtoon", "comic"],
                            "capabilities": { "search": true, "popular": true, "latest": true, "details": true, "chapters": true, "pages": true },
                            "nsfw": implementation.content_rating.unwrap_or(0) >= 2,
                            "hosts": [new_host(&implementation.base_url)],
                            "api": runtime_api_base(&headers, &source_id),
                            "runtime": "aidoku-wasm",
                            "engine": "Yomu Remote Aidoku Runtime"
                        });
                        return (StatusCode::OK, Json(json!({
                            "ok": true,
                            "ready": true,
                            "runtime": "aidoku-wasm",
                            "sourceId": source_id,
                            "confidence": "high",
                            "score": 98,
                            "adapter": adapter,
                            "probe": probe,
                            "message": format!("{} passed search → details → chapters → pages through the Aidoku runtime.", implementation.name)
                        }))).into_response();
                    }
                    Ok(Err(error)) => attempts.push(json!({"name": spec.implementation.name, "store": spec.implementation.store_id, "error": error.to_string()})),
                    Err(error) => attempts.push(json!({"name": spec.implementation.name, "store": spec.implementation.store_id, "error": format!("runtime task failed: {error}")})),
                }
            }
            Err(error) => attempts.push(json!({"name": spec.implementation.name, "store": spec.implementation.store_id, "error": error.to_string()})),
        }
    }

    (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({
        "ok": true,
        "ready": false,
        "runtime": "aidoku-wasm",
        "targetUrl": request.target_url,
        "attempts": attempts,
        "message": "Aidoku implementations were found, but none passed the full reader gauntlet."
    }))).into_response()
}

async fn source_api(
    State(state): State<AppState>,
    Path((source_id, rest)): Path<(String, String)>,
    RawQuery(raw_query): RawQuery,
) -> impl IntoResponse {
    let spec: SourceSpec = match decode_json(&source_id) {
        Ok(v) => v,
        Err(error) => return runtime_error(StatusCode::BAD_REQUEST, error),
    };
    let package = match load_package(&state, &spec).await {
        Ok(v) => v,
        Err(error) => return runtime_error(StatusCode::BAD_GATEWAY, error),
    };
    let params = parse_query(raw_query.as_deref());
    let result = tokio::task::spawn_blocking(move || run_source_route(&package, &rest, &params)).await;
    match result {
        Ok(Ok(value)) => (StatusCode::OK, Json(value)).into_response(),
        Ok(Err(error)) => runtime_error(StatusCode::BAD_GATEWAY, error),
        Err(error) => runtime_error(StatusCode::INTERNAL_SERVER_ERROR, anyhow!("runtime task failed: {error}")),
    }
}

fn runtime_error(status: StatusCode, error: anyhow::Error) -> axum::response::Response {
    (status, Json(json!({"error": error.to_string()}))).into_response()
}

fn parse_query(raw: Option<&str>) -> HashMap<String, String> {
    url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes()).into_owned().collect()
}

fn run_source_route(package: &CachedPackage, rest: &str, params: &HashMap<String, String>) -> Result<Value> {
    let mut vm = AidokuVm::new(&package.wasm)?;
    if rest == "series" || rest == "latest" {
        let page = params.get("page").and_then(|v| v.parse::<i32>().ok()).unwrap_or(1);
        let result = search_with_fallback(&mut vm, None, page)?;
        return Ok(json!({"series": result.entries.iter().map(manga_summary).collect::<Vec<_>>(), "hasNextPage": result.has_next_page}));
    }
    if rest == "search" {
        let page = params.get("page").and_then(|v| v.parse::<i32>().ok()).unwrap_or(1);
        let query = params.get("q").map(String::as_str).unwrap_or_default();
        let result = search_with_fallback(&mut vm, Some(query), page)?;
        return Ok(json!({"series": result.entries.iter().map(manga_summary).collect::<Vec<_>>(), "hasNextPage": result.has_next_page}));
    }
    if let Some(id) = rest.strip_prefix("series/") {
        let original: Manga = decode_json(id)?;
        let manga = vm.update_manga(original)?;
        let chapters = manga.chapters.clone().unwrap_or_default().iter().map(|chapter| chapter_json(&manga, chapter)).collect::<Vec<_>>();
        let mut detail = manga_summary(&manga);
        if let Some(object) = detail.as_object_mut() {
            object.insert("chapters".to_string(), Value::Array(chapters));
        }
        return Ok(detail);
    }
    if let Some(id) = rest.strip_prefix("chapters/").and_then(|x| x.strip_suffix("/manifest")) {
        let chapter_ref: ChapterRef = decode_json(id)?;
        let pages = vm.pages(chapter_ref.manga.clone(), chapter_ref.chapter.clone())?;
        let output = pages.into_iter().enumerate().filter_map(|(index, page)| match page.content {
            PageContent::Url(url, _) => Some(json!({"key": format!("{}-{index}", chapter_ref.chapter.key), "index": index, "url": url})),
            _ => None,
        }).collect::<Vec<_>>();
        if output.is_empty() {
            bail!("Aidoku source returned no directly readable image URLs for this chapter");
        }
        return Ok(json!({
            "schema": "yomu.chapter-manifest/1",
            "chapterId": id,
            "sourceSeriesId": encode_json(&chapter_ref.manga)?,
            "manifestVersion": format!("aidoku-{}-{}", chapter_ref.chapter.key, output.len()),
            "pageListVersion": output.len(),
            "expiresAt": Value::Null,
            "pages": output,
            "delivery": "direct"
        }));
    }
    bail!("Unknown Aidoku runtime endpoint: {rest}")
}

fn probe_source(package: &CachedPackage) -> Result<Value> {
    let mut vm = AidokuVm::new(&package.wasm)?;
    let search = search_with_fallback(&mut vm, None, 1)?;
    let first = search.entries.into_iter().next().ok_or_else(|| anyhow!("source returned an empty catalog"))?;
    let updated = vm.update_manga(first)?;
    let chapters = updated.chapters.clone().unwrap_or_default();
    if chapters.is_empty() {
        bail!("source returned no chapters for the probe title");
    }
    let mut page_count = 0usize;
    let mut last_error = None;
    for chapter in chapters.iter().take(3) {
        match vm.pages(updated.clone(), chapter.clone()) {
            Ok(pages) => {
                page_count = pages.iter().filter(|p| matches!(p.content, PageContent::Url(_, _))).count();
                if page_count > 0 { break; }
            }
            Err(error) => last_error = Some(error.to_string()),
        }
    }
    if page_count == 0 {
        bail!(last_error.unwrap_or_else(|| "source returned no directly readable pages".to_string()));
    }
    Ok(json!({
        "catalog": true,
        "sampleTitle": updated.title,
        "chapters": chapters.len(),
        "pages": page_count,
        "sourceMetadata": package.source_json
    }))
}

fn search_with_fallback(vm: &mut AidokuVm, query: Option<&str>, page: i32) -> Result<SearchPage> {
    match vm.search(query, page) {
        Ok(result) if !result.entries.is_empty() => Ok(result),
        Ok(result) if query.is_some() => Ok(result),
        Ok(_) | Err(_) => vm.search(Some("a"), page),
    }
}

fn manga_summary(manga: &Manga) -> Value {
    json!({
        "id": encode_json(manga).unwrap_or_default(),
        "title": manga.title,
        "author": manga.authors.as_ref().map(|v| v.join(", ")),
        "synopsis": manga.description,
        "genres": manga.tags,
        "category": match manga.viewer { Viewer::Webtoon | Viewer::Vertical => "webtoon", Viewer::RightToLeft => "manga", Viewer::LeftToRight => "comic", _ => "manga" },
        "status": match manga.status { MangaStatus::Ongoing => "ongoing", MangaStatus::Completed => "completed", MangaStatus::Cancelled => "cancelled", MangaStatus::Hiatus => "hiatus", _ => "unknown" },
        "cover": manga.cover,
        "nsfw": manga.content_rating == ContentRating::NSFW,
    })
}

fn chapter_json(manga: &Manga, chapter: &Chapter) -> Value {
    let reference = ChapterRef { manga: manga.clone(), chapter: chapter.clone() };
    let number = chapter.chapter_number.unwrap_or(0.0);
    json!({
        "id": encode_json(&reference).unwrap_or_default(),
        "number": number,
        "name": chapter.title.clone().unwrap_or_else(|| if number > 0.0 { format!("Chapter {number}") } else { "Chapter".to_string() }),
        "publishedAt": chapter.date_uploaded.map(|v| if v < 10_000_000_000 { v * 1000 } else { v }),
        "scanlator": chapter.scanlators.as_ref().map(|v| v.join(", ")),
    })
}

async fn load_package(state: &AppState, spec: &SourceSpec) -> Result<Arc<CachedPackage>> {
    let key = package_key(spec);
    if let Some(package) = state.packages.read().await.get(&key).cloned() {
        return Ok(package);
    }
    let artifact_url = artifact_url(&spec.implementation)?;
    let response = state.client.get(artifact_url).send().await?.error_for_status()?;
    let bytes = response.bytes().await?.to_vec();
    let package = tokio::task::spawn_blocking(move || unpack_aix(bytes)).await??;
    let package = Arc::new(package);
    state.packages.write().await.insert(key, package.clone());
    Ok(package)
}

fn unpack_aix(bytes: Vec<u8>) -> Result<CachedPackage> {
    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).context("invalid .aix package")?;
    let mut wasm = None;
    let mut source_json = None;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        let name = file.name().to_string();
        if name.ends_with("/main.wasm") || name == "main.wasm" {
            let mut buffer = Vec::new();
            file.read_to_end(&mut buffer)?;
            wasm = Some(buffer);
        } else if name.ends_with("/source.json") || name == "source.json" {
            let mut text = String::new();
            file.read_to_string(&mut text)?;
            source_json = serde_json::from_str(&text).ok();
        }
    }
    let wasm = wasm.ok_or_else(|| anyhow!(".aix package does not contain Payload/main.wasm"))?;
    Ok(CachedPackage { wasm: Arc::new(wasm), source_json })
}

fn artifact_url(implementation: &Implementation) -> Result<String> {
    let base = match implementation.store_id.as_str() {
        "aidoku-yomu-community" => "https://smexhy.github.io/yomu-aidoku-sources/",
        "aidoku-community" => "https://aidoku-community.github.io/sources/",
        _ => bail!("Aidoku store is not allowlisted by the runtime: {}", implementation.store_id),
    };
    let artifact = implementation.artifact.as_deref().ok_or_else(|| anyhow!("Aidoku implementation has no .aix artifact"))?;
    let url = url::Url::parse(base)?.join(artifact)?;
    if !url.as_str().ends_with(".aix") {
        bail!("Aidoku artifact is not an .aix package");
    }
    Ok(url.to_string())
}

fn package_key(spec: &SourceSpec) -> String {
    let implementation = &spec.implementation;
    format!("{}:{}:{}", implementation.store_id, implementation.id.as_deref().unwrap_or(&implementation.name), implementation.version.as_deref().unwrap_or("0"))
}

fn encode_json<T: Serialize>(value: &T) -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(value)?))
}

fn decode_json<T: DeserializeOwned>(value: &str) -> Result<T> {
    let bytes = URL_SAFE_NO_PAD.decode(value).context("invalid runtime id")?;
    serde_json::from_slice(&bytes).context("invalid runtime payload")
}

fn runtime_api_base(headers: &HeaderMap, source_id: &str) -> String {
    let host = headers.get("x-forwarded-host").or_else(|| headers.get("host")).and_then(|v| v.to_str().ok()).unwrap_or("localhost:8080");
    let proto = headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()).unwrap_or(if host.starts_with("localhost") { "http" } else { "https" });
    format!("{proto}://{host}/v1/source/{source_id}/")
}

fn new_host(value: &str) -> String {
    url::Url::parse(value).ok().and_then(|v| v.host_str().map(str::to_string)).unwrap_or_default()
}

fn slug(value: &str) -> String {
    value.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect::<String>().trim_matches('-').chars().take(48).collect()
}
