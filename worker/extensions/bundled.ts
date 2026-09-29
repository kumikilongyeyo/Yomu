/**
 * Adapters compiled into the Worker.
 *
 * These are the *same files* the GitHub repository serves -- `extensions/` is
 * one directory that is both published and bundled. Bundling them means Yomu
 * has a working source set before the repo exists, and keeps one if the repo
 * ever goes away; when the repo is configured and reachable, its copies win and
 * a version bump there takes effect without redeploying Yomu.
 */
import mangapdf from '../../extensions/sources/mangapdf.json';
import weebcentral from '../../extensions/sources/weebcentral.json';
import flamecomics from '../../extensions/sources/flamecomics.json';
import webtoons from '../../extensions/sources/webtoons.json';
import asura from '../../extensions/sources/asura.json';
import namicomi from '../../extensions/sources/namicomi.json';
import comick from '../../extensions/sources/comick.json';
import xoxocomics from '../../extensions/sources/xoxocomics.json';
import readallcomics from '../../extensions/sources/readallcomics.json';
import hivetoons from '../../extensions/sources/hivetoons.json';
import vortexscans from '../../extensions/sources/vortexscans.json';
import magustoon from '../../extensions/sources/magustoon.json';
import nyxscans from '../../extensions/sources/nyxscans.json';
import tcbscans from '../../extensions/sources/tcbscans.json';
import toongod from '../../extensions/sources/toongod.json';

export const BUNDLED_DESCRIPTORS: Record<string, unknown> = {
  mangapdf,
  weebcentral,
  flamecomics,
  webtoons,
  asura,
  namicomi,
  comick,
  xoxocomics,
  readallcomics,
  hivetoons,
  vortexscans,
  magustoon,
  nyxscans,
  tcbscans,
  toongod,
};
