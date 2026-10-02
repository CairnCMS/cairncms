import { mergeConfig } from 'vitest/config';
import controls from './controls.config';

export default mergeConfig(controls, { test: { hookTimeout: 300 } });
