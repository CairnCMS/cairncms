import { redisControl } from './redis-control';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

redisControl('redis7');
