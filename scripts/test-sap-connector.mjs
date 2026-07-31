#!/usr/bin/env node
/** SAP Connector interface stub tests (Phase 14) — must never actually connect */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SAPConnector, SAPGuiConnector, SAPApiConnector, SAPFileExportConnector } from '../FinanceOS/js/sap-connector.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'FinanceOS/js');
const src = readFileSync(join(root, 'sap-connector.js'), 'utf8');

let failed = 0;
function check(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}

// No network/credential code anywhere in the connector file
check(!/fetch\(|XMLHttpRequest|WebSocket|apiKey|password|Authorization/i.test(src), 'sap-connector.js must contain no network calls or credential handling');

// Base class methods are unimplemented — never silently succeed
{
  const base = new SAPConnector();
  let threw = false;
  try { base.validate({}); } catch { threw = true; }
  check(threw, 'SAPConnector.validate() must throw (unimplemented by design)');

  let submitThrew = false;
  try { await base.submit({}); } catch { submitThrew = true; }
  check(submitThrew, 'SAPConnector.submit() must throw (unimplemented by design) — never posts to SAP');
}

// Concrete subclasses exist for each future integration method, still unimplemented
for (const [Cls, expectedNameFragment] of [
  [SAPGuiConnector, 'GUI'],
  [SAPApiConnector, 'API'],
  [SAPFileExportConnector, 'File'],
]) {
  const instance = new Cls();
  check(instance.name.includes(expectedNameFragment), `${Cls.name}.name should mention "${expectedNameFragment}", got "${instance.name}"`);
  let submitThrew = false;
  try { await instance.submit({}); } catch { submitThrew = true; }
  check(submitThrew, `${Cls.name}.submit() must still throw — no phase of this build may post to SAP`);
}

console.log(failed ? `${failed} test(s) failed` : '✓ SAP connector interface tests passed');
process.exit(failed ? 1 : 0);
