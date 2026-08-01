#!/usr/bin/env node
'use strict';
// Selfcheck runner for lib/rewards/horizon — same shape as the other lib/*.test.js files
// (plain node script, no framework). Run: node lib/rewards/horizon.test.js
require('./horizon').selfcheck();
