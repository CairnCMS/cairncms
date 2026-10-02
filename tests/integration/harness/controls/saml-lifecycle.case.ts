import { samlTest } from '../../fixtures/saml';
import { serviceLifecycleControl } from './service-lifecycle-control';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

serviceLifecycleControl(samlTest);
