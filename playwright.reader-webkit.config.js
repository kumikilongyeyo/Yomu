import base from './playwright.config.js';
import { devices, defineConfig } from '@playwright/test';
export default defineConfig({ ...base, testMatch: /reader-reliability\.spec\.js/, projects: [{name:'iphone-webkit', use:{...devices['iPhone 13'], browserName:'webkit'}}] });
