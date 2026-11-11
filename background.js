import { createSiteSearchService } from "./site-discovery-service.js";

const discovery = createSiteSearchService(globalThis.browser);
void discovery.start().catch(() => {
  // Local discovery must never prevent the popup's ordinary tab/search actions.
});
