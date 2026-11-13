// Answers the page's `refreshSocialGraph` message with one follow-list
// catch-up pass. Installed before the library's handler, which would not know
// the message.
import { requestGraphSync } from './graphSyncOnDemand';

self.addEventListener('message', (event) => {
  if ((event as MessageEvent<{ type?: unknown }>).data?.type !== 'refreshSocialGraph') return;
  event.stopImmediatePropagation();
  requestGraphSync();
});
