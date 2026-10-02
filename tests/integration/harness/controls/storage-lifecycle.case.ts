import { createStorageTest } from '../../fixtures/storage';
import { serviceLifecycleControl } from './service-lifecycle-control';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

serviceLifecycleControl(createStorageTest());
