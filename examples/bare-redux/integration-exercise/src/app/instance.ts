import { createAppStore } from '../store/store';
import { createRealTimers } from '../sync/real-timers';
import { createSimulatedServer } from '../sync/server';

// The one store the screen renders. The device build has no backend: a simulated sync server
// answers every save, timed by the injected real clock.
export const store = createAppStore({ sync: createSimulatedServer(createRealTimers()) });
