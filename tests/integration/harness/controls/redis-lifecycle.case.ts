import { createRedisTest } from '../../fixtures/redis';
import { serviceLifecycleControl } from './service-lifecycle-control';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

serviceLifecycleControl(createRedisTest());
