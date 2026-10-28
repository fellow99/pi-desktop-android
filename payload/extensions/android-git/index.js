// synced-from: pi-desktop-hos@d9511ae（单源：pi-desktop-hos/extensions/harmony-git；请勿在本工程侧直接修改）
// harmony-git — pi-agent 扩展工厂
// 由 $PI_CODING_AGENT_DIR/extensions/ 加载；导出 default function (pi) => void
import init from './lib/tools/init.js';
import clone from './lib/tools/clone.js';
import status from './lib/tools/status.js';
import log from './lib/tools/log.js';
import show from './lib/tools/show.js';
import branch from './lib/tools/branch.js';
import add from './lib/tools/add.js';
import commit from './lib/tools/commit.js';
import checkout from './lib/tools/checkout.js';
import reset from './lib/tools/reset.js';
import merge from './lib/tools/merge.js';
import cherryPick from './lib/tools/cherry-pick.js';
import revert from './lib/tools/revert.js';
import stash from './lib/tools/stash.js';
import tag from './lib/tools/tag.js';
import diff from './lib/tools/diff.js';
import remote from './lib/tools/remote.js';
import fetchTool from './lib/tools/fetch.js';
import pull from './lib/tools/pull.js';
import push from './lib/tools/push.js';
import config from './lib/tools/config.js';
import credentials from './lib/tools/credentials.js';

const TOOLS = [
  init, clone, status, log, show, branch, add, commit, checkout, reset,
  merge, cherryPick, revert, stash, tag, diff, remote, fetchTool, pull, push, config, credentials,
];

export default function register(pi) {
  for (const tool of TOOLS) {
    pi.registerTool(tool);
  }
  // 无长驻资源（vendor 懒加载缓存随进程生命周期），无需 session_shutdown 清理
}
