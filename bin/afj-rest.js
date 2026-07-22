#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires, no-undef */

require('dotenv').config()

const { runCliServer } = require('../build/cli')

runCliServer()
