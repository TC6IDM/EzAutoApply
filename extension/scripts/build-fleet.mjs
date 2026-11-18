// `npm run build:fleet`: the fleet's own copy of the extension (#33, docs/agent-fleet-plan.md §8.3).
// A production build like `npm run build`, into .output/fleet-chrome-mv3 and named
// "EzAutoApply (fleet)", so the live Fixer can rebuild and reload it in the fleet's Chrome
// profile without touching the owner's own copy. wxt.config.ts reads EZAA_FLEET.
// (Not `wxt build --mode fleet`: WXT sets NODE_ENV to the mode, which gives React's
// development build.)
import { build } from 'wxt';

process.env.EZAA_FLEET = '1';
await build();
