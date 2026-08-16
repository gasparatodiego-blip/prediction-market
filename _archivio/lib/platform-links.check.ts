// Runnable unit checks for lib/platform-links.ts.
//   npx tsx lib/platform-links.check.ts
import { _platformLinksSelfTest } from './platform-links';

try {
  _platformLinksSelfTest();
  console.log('platform-links: all URL-builder checks passed ✓');
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
