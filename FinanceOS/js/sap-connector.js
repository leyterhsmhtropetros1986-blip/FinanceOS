/**
 * SAP Connector abstraction (Phase 14) — INTERFACE ONLY.
 *
 * FinanceOS business logic (extraction, matching, validation, SAP
 * preparation) must never depend directly on how a record eventually
 * reaches SAP. This file defines that boundary so the integration method
 * can be swapped later without touching anything upstream:
 *
 *   FinanceOS → SAP Preparation → SAPConnector interface → [SAP GUI | SAP API | File Export]
 *
 * NOTHING in this file connects to SAP. There is no network call, no
 * credential handling, and no code path that reaches SAPConnector from any
 * UI action in this phase — "Prepare for SAP" (invoices.js) stops at the
 * FinanceOS-local SAP-ready record and never calls anything here.
 */

/** @abstract */
export class SAPConnector {
  /** @returns {string} a short, human name for whichever backend this is. */
  get name() {
    throw new Error('SAPConnector.name must be implemented by a subclass');
  }

  /**
   * Validate that a SAPReadyInvoice record (see sap-preparation.js) has
   * everything this connector would need. Implementations must NOT post
   * anything — validation only.
   * @param {object} _sapReadyRecord
   * @returns {{ ready: boolean, missing: string[] }}
   */
  validate(_sapReadyRecord) {
    throw new Error(`${this.constructor.name}.validate() is not implemented — this phase ships interfaces only`);
  }

  /**
   * Would eventually submit a SAPReadyInvoice to SAP through this
   * connector's transport. Intentionally unimplemented — no phase of this
   * build is permitted to post to production SAP.
   * @param {object} _sapReadyRecord
   */
  async submit(_sapReadyRecord) {
    throw new Error(`${this.constructor.name}.submit() is not implemented — SAP posting is out of scope for this phase`);
  }
}

/** Future: drives SAP GUI Scripting (SAP GUI for Windows automation). */
export class SAPGuiConnector extends SAPConnector {
  get name() { return 'SAP GUI Scripting'; }
}

/** Future: talks to SAP via OData/REST API or BAPI/RFC gateway. */
export class SAPApiConnector extends SAPConnector {
  get name() { return 'SAP API (OData/BAPI)'; }
}

/** Future: writes a controlled interface file (e.g. IDoc-style flat file /
 *  CSV drop folder) for a separate, already-authorized SAP interface job to
 *  pick up — no direct connection to SAP from FinanceOS at all. */
export class SAPFileExportConnector extends SAPConnector {
  get name() { return 'Controlled File/Interface Export'; }
}
