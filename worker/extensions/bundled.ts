/**
 * Adapters compiled into the Worker.
 *
 * These are the *same files* the GitHub repository serves -- `extensions/` is
 * one directory that is both published and bundled. Bundling them means Yomu
 * has a working source set before the repo exists, and keeps one if the repo
 * ever goes away; when the repo is configured and reachable, its copies win and
 * a version bump there takes effect without redeploying Yomu.
 */
import weebcentral from '../../extensions/sources/weebcentral.json';
import flamecomics from '../../extensions/sources/flamecomics.json';
import webtoons from '../../extensions/sources/webtoons.json';
import asura from '../../extensions/sources/asura.json';
import namicomi from '../../extensions/sources/namicomi.json';
import comick from '../../extensions/sources/comick.json';

export const BUNDLED_DESCRIPTORS: Record<string, unknown> = {
  weebcentral,
  flamecomics,
  webtoons,
  asura,
  namicomi,
  comick,
};
