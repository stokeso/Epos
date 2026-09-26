/**
 * Backup file validation (spec §8; D-088, D-089): structure and version are checked before any
 * data is touched. The adapter round trip itself is in the repository contract suite.
 */
import { describe, expect, it } from 'vitest';
import {
  BACKUP_NOT_JSON_MESSAGE,
  BACKUP_NOT_OBJECT_MESSAGE,
  BACKUP_NO_MANAGER_MESSAGE,
  BACKUP_TOO_LARGE_MESSAGE,
  BACKUP_WRONG_FORMAT_MESSAGE,
  BACKUP_WRONG_VERSION_MESSAGE,
  MAX_BACKUP_BYTES,
  MAX_BACKUP_PROBLEMS,
  parseBackupText,
  serialiseBackup,
  validateBackupValue,
  type BackupValidation,
} from '../../src/data/backup';
import { buildOutboxEntry } from '../../src/data/outbox';
import type { BackupFile, Category } from '../../src/data/types';
import { BACKUP_FORMAT, ENTITY_NAMES, SCHEMA_VERSION } from '../../src/data/types';
import { isValidLocalDate } from '../../src/rules/time';

const AT = '2026-09-26T10:00:00.000Z';
const DEVICE = '3f9c2a1e-7b4d-4e8a-9c1f-5a6b7c8d9e0f';

function uuid(n: number): string {
  return `3f9c2a1e-7b4d-4e8a-9c1f-${n.toString(16).padStart(12, '0')}`;
}

type Row = Record<string, unknown>;

interface LooseFile {
  [key: string]: unknown;
  tables: Record<string, Row[]>;
}

const IDS = {
  manager: uuid(1),
  category: uuid(2),
  lager: uuid(3),
  deal: uuid(4),
  member: uuid(5),
  booking: uuid(6),
  tab: uuid(7),
  period: uuid(8),
  sale: uuid(9),
  refund: uuid(10),
  movement: uuid(11),
} as const;

function base(id: string): Row {
  return { id, deviceId: DEVICE, createdAt: AT, updatedAt: AT };
}

/** A small but complete valid backup: one row per table, every audit type, a few outbox rows. */
function validFile(): LooseFile {
  const saleLine = {
    productId: IDS.lager,
    nameAtSale: 'Fairway Lager',
    qty: 2,
    unitPricePence: 450,
    vatRate: 20,
    dealDiscountPence: 100,
    memberDiscountPence: 0,
    finalPence: 800,
    vatPence: 133,
  };
  const category = { ...base(IDS.category), name: 'Draught', sortOrder: 1, colour: '#b45309' };
  const audit = (n: number, type: string, detail: Row, extra: Row = {}): Row => ({ ...base(uuid(100 + n)), type, staffId: IDS.manager, detail, ...extra });
  const file: LooseFile = {
    format: BACKUP_FORMAT,
    version: SCHEMA_VERSION,
    exportedAt: AT,
    deviceId: DEVICE,
    tables: {
      staff: [{ ...base(IDS.manager), name: 'Morgan Manager', role: 'manager', pinHash: 'ab'.repeat(32), pinSalt: 'cd'.repeat(16), active: true }],
      categories: [category],
      products: [
        {
          ...base(IDS.lager),
          name: 'Fairway Lager',
          categoryId: IDS.category,
          pricePence: 450,
          vatRate: 20,
          memberDiscountEligible: true,
          stockTracked: true,
          stockUnit: 'pint',
          lowStockLevel: 22,
          buttonColour: '#b45309',
          sortOrder: 1,
          active: true,
        },
      ],
      deals: [{ ...base(IDS.deal), name: '2 for £8', type: 'nForPrice', n: 2, pricePence: 800, productIds: [IDS.lager], active: true, startsAt: AT }],
      members: [{ ...base(IDS.member), memberNumber: '1042', firstName: 'Alice', lastName: 'Archer', active: true, deletedAt: AT }],
      bookings: [{ ...base(IDS.booking), type: 'wedding', name: 'Smith wedding', date: '2026-10-26', notes: '', status: 'open' }],
      tabs: [
        {
          ...base(IDS.tab),
          labelType: 'name',
          label: 'Smith',
          openedAt: AT,
          openedBy: IDS.manager,
          status: 'settled',
          lines: [{ productId: IDS.lager, qty: 2 }],
          memberId: IDS.member,
        },
      ],
      sales: [
        {
          ...base(IDS.sale),
          receiptNumber: '3F9C-000001',
          periodId: IDS.period,
          staffId: IDS.manager,
          kind: 'sale',
          memberId: IDS.member,
          tabId: IDS.tab,
          lines: [saleLine],
          dealLines: [{ dealId: IDS.deal, name: '2 for £8', groupCount: 1, savingPence: 100 }],
          memberDiscountPence: 0,
          depositAppliedPence: 0,
          totalPence: 800,
          tenders: [
            { type: 'card', amountPence: 300 },
            { type: 'cash', amountPence: 1000 },
          ],
          changePence: 500,
        },
        {
          ...base(IDS.refund),
          receiptNumber: '3F9C-000002',
          periodId: IDS.period,
          staffId: IDS.manager,
          kind: 'refund',
          refundOfSaleId: IDS.sale,
          lines: [{ ...saleLine, qty: -1, dealDiscountPence: -50, finalPence: -400, vatPence: -67, refundOfLineIndex: 0, returnToStock: true }],
          dealLines: [],
          memberDiscountPence: 0,
          depositAppliedPence: 0,
          totalPence: -400,
          tenders: [{ type: 'cash', amountPence: -400 }],
          changePence: 0,
        },
      ],
      stockMovements: [{ ...base(IDS.movement), productId: IDS.lager, qty: -2, reason: 'sale', saleId: IDS.sale, staffId: IDS.manager, note: '' }],
      periods: [
        {
          ...base(IDS.period),
          openedAt: AT,
          openedBy: IDS.manager,
          floatPence: 10000,
          closedAt: AT,
          closedBy: IDS.manager,
          declaredCashPence: 10300,
          zNumber: 1,
        },
      ],
      auditEvents: [
        audit(1, 'void', { productId: IDS.lager, productName: 'Fairway Lager', qty: 1, unitPricePence: 450, tabId: IDS.tab }, { approvedById: IDS.manager, periodId: IDS.period }),
        audit(2, 'noSale', {}, { periodId: IDS.period }),
        audit(3, 'refund', {
          refundSaleId: IDS.refund,
          refundReceiptNumber: '3F9C-000002',
          originalSaleId: IDS.sale,
          originalReceiptNumber: '3F9C-000001',
          totalPence: -400,
          tender: 'cash',
          lines: [{ productId: IDS.lager, qty: 1, returnToStock: true }],
        }),
        audit(4, 'priceChange', { productId: IDS.lager, productName: 'Fairway Lager', oldPricePence: 420, newPricePence: 450 }),
        audit(5, 'override', { action: 'voidLine' }),
        audit(6, 'stockAdjust', { stockMovementId: IDS.movement, productId: IDS.lager, productName: 'Fairway Lager', qty: -2, reason: 'waste', note: 'Spilt' }),
        audit(7, 'zClose', { zNumber: 1, floatPence: 10000, expectedCashPence: 10300, declaredCashPence: 10300, variancePence: 0 }),
        audit(8, 'backupExport', { exportedAt: AT }),
        audit(9, 'backupImport', { fileExportedAt: AT, fileDeviceId: DEVICE, importedByName: 'Morgan Manager' }),
      ],
      settings: [
        {
          ...base(DEVICE),
          clubName: 'Oakfield Golf Club',
          receiptFooter: 'Thank you for your custom',
          autoLockMinutes: 5,
          memberDiscountPercent: 15,
          lastBackupAt: AT,
          devicePrefix: '3F9C',
          receiptCounter: 2,
        },
      ],
      outbox: [
        { seq: 1, ...buildOutboxEntry('categories', 'create', category as unknown as Category, AT, uuid(200)) },
        { seq: 2, ...buildOutboxEntry('categories', 'delete', { ...category, deletedAt: AT } as unknown as Category, AT, uuid(201)), syncedAt: AT },
      ],
    },
  };
  return JSON.parse(JSON.stringify(file)) as LooseFile;
}

function rowOf(file: LooseFile, table: string, index = 0): Row {
  const row = file.tables[table]?.[index];
  if (row === undefined) throw new Error(`no row ${table}[${index}]`);
  return row;
}

function check(mutate: (file: LooseFile) => void): BackupValidation {
  const file = validFile();
  mutate(file);
  return validateBackupValue(file);
}

function problemsOf(result: BackupValidation): string[] {
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.problems;
}

/** The validation fails and some problem contains each expected fragment. */
function expectProblems(result: BackupValidation, ...fragments: string[]): void {
  const problems = problemsOf(result);
  for (const fragment of fragments) {
    expect(
      problems.some((p) => p.includes(fragment)),
      `expected a problem containing ${JSON.stringify(fragment)} in ${JSON.stringify(problems)}`,
    ).toBe(true);
  }
}

describe('a valid backup', () => {
  it('passes and returns the same file', () => {
    const file = validFile();
    const result = validateBackupValue(file);
    expect(result.ok ? [] : result.problems).toEqual([]);
    expect(result).toEqual({ ok: true, file });
  });

  it('accepts optional fields when absent and syncedAt null or an instant', () => {
    const result = check((f) => {
      delete rowOf(f, 'deals').startsAt;
      delete rowOf(f, 'settings').lastBackupAt;
      delete rowOf(f, 'members').deletedAt;
      delete rowOf(f, 'sales').memberId;
      rowOf(f, 'outbox', 0).syncedAt = null;
    });
    expect(result.ok ? [] : result.problems).toEqual([]);
  });

  it('accepts empty tables other than settings and staff', () => {
    const result = check((f) => {
      for (const key of ['categories', 'products', 'deals', 'members', 'bookings', 'tabs', 'sales', 'stockMovements', 'periods', 'auditEvents', 'outbox']) {
        f.tables[key] = [];
      }
    });
    expect(result.ok ? [] : result.problems).toEqual([]);
  });
});

describe('parseBackupText and serialiseBackup (D-088)', () => {
  it('serialises with two-space indentation and parses back', () => {
    const file = validFile() as unknown as BackupFile;
    const text = serialiseBackup(file);
    expect(text).toBe(JSON.stringify(file, null, 2));
    expect(parseBackupText(text, text.length)).toEqual({ ok: true, file });
  });

  it('rejects a file over 50 MB before parsing it', () => {
    const text = serialiseBackup(validFile() as unknown as BackupFile);
    expect(MAX_BACKUP_BYTES).toBe(50 * 1024 * 1024);
    expect(parseBackupText(text, MAX_BACKUP_BYTES + 1)).toEqual({ ok: false, problems: [BACKUP_TOO_LARGE_MESSAGE] });
    expect(parseBackupText(text, MAX_BACKUP_BYTES).ok).toBe(true);
  });

  it('reports invalid JSON as a problem instead of throwing', () => {
    expect(parseBackupText('{"format": ', 11)).toEqual({ ok: false, problems: [BACKUP_NOT_JSON_MESSAGE] });
    expect(parseBackupText('', 0)).toEqual({ ok: false, problems: [BACKUP_NOT_JSON_MESSAGE] });
  });

  it('rejects a top level that is not an object', () => {
    for (const text of ['null', '[]', '42', '"backup"', 'true']) {
      expect(parseBackupText(text, text.length)).toEqual({ ok: false, problems: [BACKUP_NOT_OBJECT_MESSAGE] });
    }
  });
});

describe('format and version are checked first (D-089)', () => {
  it('rejects the wrong format with that single problem', () => {
    for (const format of ['something-else', undefined, 1]) {
      const result = check((f) => {
        f.format = format;
        f.tables = {};
      });
      expect(result).toEqual({ ok: false, problems: [BACKUP_WRONG_FORMAT_MESSAGE] });
    }
  });

  it("rejects another version with 'This backup was made by a different version'", () => {
    for (const version of [2, 0, '1', undefined]) {
      const result = check((f) => {
        f.version = version;
        f.tables = {};
      });
      expect(result).toEqual({ ok: false, problems: [BACKUP_WRONG_VERSION_MESSAGE] });
    }
    expect(BACKUP_WRONG_VERSION_MESSAGE).toBe('This backup was made by a different version');
  });
});

describe('file structure (D-089)', () => {
  it('requires exportedAt to be a valid ISO instant', () => {
    for (const exportedAt of ['yesterday', '2026-13-01T00:00:00.000Z', '2026-02-30T10:00:00.000Z', '2026-09-26T10:00:00Z', 1727344800000, undefined]) {
      expectProblems(
        check((f) => {
          f.exportedAt = exportedAt;
        }),
        'exportedAt is not a valid ISO instant',
      );
    }
  });

  it('requires a UUID v4 deviceId and no unknown top-level fields', () => {
    expectProblems(
      check((f) => {
        f.deviceId = 'my-till';
      }),
      'deviceId must be a UUID v4',
    );
    expectProblems(
      check((f) => {
        f.comment = 'hello';
      }),
      'unknown field "comment"',
    );
  });

  it('requires exactly the 13 table keys, each a list', () => {
    expectProblems(
      check((f) => {
        delete f.tables.periods;
      }),
      'tables is missing "periods"',
    );
    expectProblems(
      check((f) => {
        f.tables.draft = [];
      }),
      'tables has an unknown key "draft"',
    );
    expectProblems(
      check((f) => {
        (f.tables as Record<string, unknown>).sales = {};
      }),
      'tables.sales must be a list',
    );
    expectProblems(
      check((f) => {
        (f as Record<string, unknown>).tables = [];
      }),
      'tables must be an object',
    );
    expect([...ENTITY_NAMES, 'outbox']).toHaveLength(13);
  });
});

describe('rows (D-089)', () => {
  it('reports a missing required field and an unknown field with their location', () => {
    expectProblems(
      check((f) => {
        delete rowOf(f, 'staff').pinHash;
      }),
      'tables.staff[0]: missing field "pinHash"',
    );
    expectProblems(
      check((f) => {
        rowOf(f, 'categories').emoji = '🍺';
      }),
      'tables.categories[0]: unknown field "emoji"',
    );
    expectProblems(
      check((f) => {
        rowOf(f, 'sales').deletedAt = AT;
      }),
      'tables.sales[0]: unknown field "deletedAt"',
    );
  });

  it('requires integer money and quantity fields', () => {
    expectProblems(
      check((f) => {
        rowOf(f, 'products').pricePence = 4.5;
      }),
      'tables.products[0].pricePence: must be a whole number',
    );
    expectProblems(
      check((f) => {
        rowOf(f, 'products').pricePence = '450';
      }),
      'tables.products[0].pricePence: must be a whole number',
    );
    expectProblems(
      check((f) => {
        rowOf(f, 'stockMovements').qty = 2 ** 53;
      }),
      'tables.stockMovements[0].qty: must be a whole number',
    );
  });

  it('checks primitive types', () => {
    expectProblems(
      check((f) => {
        rowOf(f, 'products').active = 'yes';
        rowOf(f, 'members').firstName = 42;
        rowOf(f, 'bookings').notes = null;
      }),
      'tables.products[0].active: must be true or false',
      'tables.members[0].firstName: must be text',
      'tables.bookings[0].notes: must be text',
    );
  });

  it('checks enum values', () => {
    expectProblems(
      check((f) => {
        rowOf(f, 'staff').role = 'owner';
        rowOf(f, 'sales').kind = 'gift';
        rowOf(f, 'stockMovements').reason = 'theft';
        rowOf(f, 'bookings').status = 'maybe';
        rowOf(f, 'deals').type = 'bogof';
        rowOf(f, 'tabs').labelType = 'seat';
      }),
      'tables.staff[0].role: must be one of staff, supervisor, manager',
      'tables.sales[0].kind',
      'tables.stockMovements[0].reason',
      'tables.bookings[0].status',
      'tables.deals[0].type',
      'tables.tabs[0].labelType',
    );
  });

  it('requires UUID v4 ids and references', () => {
    expectProblems(
      check((f) => {
        rowOf(f, 'categories').id = 'draught';
      }),
      'tables.categories[0].id: must be a UUID v4',
    );
    expectProblems(
      check((f) => {
        rowOf(f, 'products').categoryId = '3f9c2a1e-7b4d-1e8a-9c1f-5a6b7c8d9e0f'; // version 1
      }),
      'tables.products[0].categoryId: must be a UUID v4',
    );
    expectProblems(
      check((f) => {
        rowOf(f, 'deals').productIds = [IDS.lager, 'lager'];
      }),
      'tables.deals[0].productIds[1]: must be a UUID v4',
    );
  });

  it('requires ISO timestamps and real calendar dates', () => {
    expectProblems(
      check((f) => {
        rowOf(f, 'periods').createdAt = '26/09/2026 10:00';
        rowOf(f, 'members').deletedAt = 'never';
        rowOf(f, 'bookings').date = '2026-02-30';
      }),
      'tables.periods[0].createdAt: must be an ISO timestamp',
      'tables.members[0].deletedAt: must be an ISO timestamp',
      'tables.bookings[0].date: must be a date (YYYY-MM-DD)',
    );
  });

  it('accepts exactly the dates the rules accept, including years 0000-0099 (D-129)', () => {
    for (const date of ['0000-01-01', '0000-02-29', '0026-10-10', '0099-12-31', '0100-01-01', '9999-12-31']) {
      const result = check((f) => {
        rowOf(f, 'bookings').date = date;
      });
      expect(result.ok ? [] : result.problems, date).toEqual([]);
      expect(isValidLocalDate(date), date).toBe(true);
    }
    for (const date of ['0001-02-29', '0100-02-29', '0026-02-30', '0000-00-01', '10000-01-01']) {
      expectProblems(
        check((f) => {
          rowOf(f, 'bookings').date = date;
        }),
        'tables.bookings[0].date: must be a date (YYYY-MM-DD)',
      );
      expect(isValidLocalDate(date), date).toBe(false);
    }
  });

  it('checks embedded lines, tenders and deal lines', () => {
    expectProblems(
      check((f) => {
        const sale = rowOf(f, 'sales');
        (sale.lines as Row[])[0] = { ...(sale.lines as Row[])[0], qty: 1.5 };
        sale.tenders = [{ type: 'cheque', amountPence: 800 }];
        sale.dealLines = [{ dealId: IDS.deal, name: '2 for £8', groupCount: 1 }];
        rowOf(f, 'tabs').lines = [{ productId: IDS.lager }];
      }),
      'tables.sales[0].lines[0].qty: must be a whole number',
      'tables.sales[0].tenders[0].type',
      'tables.sales[0].dealLines[0]: missing field "savingPence"',
      'tables.tabs[0].lines[0]: missing field "qty"',
    );
  });

  it('checks each audit detail against its type (D-084)', () => {
    expectProblems(
      check((f) => {
        delete (rowOf(f, 'auditEvents', 0).detail as Row).productName;
        (rowOf(f, 'auditEvents', 1).detail as Row).drawer = 'open';
        (rowOf(f, 'auditEvents', 4).detail as Row).action = 'fly';
        rowOf(f, 'auditEvents', 6).detail = 'closed';
      }),
      'tables.auditEvents[0].detail: missing field "productName"',
      'tables.auditEvents[1].detail: unknown field "drawer"',
      'tables.auditEvents[4].detail.action',
      'tables.auditEvents[6].detail: must be an object',
    );
    expectProblems(
      check((f) => {
        rowOf(f, 'auditEvents', 0).type = 'login';
      }),
      'tables.auditEvents[0].type',
    );
  });

  it('checks outbox rows and their payloads', () => {
    expectProblems(
      check((f) => {
        rowOf(f, 'outbox', 0).seq = 1.5;
        rowOf(f, 'outbox', 0).entity = 'draft';
        rowOf(f, 'outbox', 1).syncedAt = 'soon';
        rowOf(f, 'outbox', 1).operation = 'upsert';
      }),
      'tables.outbox[0].seq: must be a whole number',
      'tables.outbox[0].entity',
      'tables.outbox[1].syncedAt: must be an ISO timestamp or null',
      'tables.outbox[1].operation',
    );
    expectProblems(
      check((f) => {
        delete (rowOf(f, 'outbox', 0).payload as Row).colour;
      }),
      'tables.outbox[0].payload: missing field "colour"',
    );
  });
});

describe('uniqueness, settings and manager (D-089)', () => {
  it('rejects duplicate ids in a table', () => {
    expectProblems(
      check((f) => {
        f.tables.categories = [rowOf(f, 'categories'), { ...rowOf(f, 'categories'), name: 'Copy' }];
      }),
      `tables.categories: duplicate id "${IDS.category}"`,
    );
  });

  it('rejects duplicate outbox seq or id', () => {
    expectProblems(
      check((f) => {
        rowOf(f, 'outbox', 1).seq = 1;
      }),
      'tables.outbox: duplicate seq 1',
    );
    expectProblems(
      check((f) => {
        rowOf(f, 'outbox', 1).id = rowOf(f, 'outbox', 0).id;
      }),
      `tables.outbox: duplicate id "${uuid(200)}"`,
    );
  });

  it('requires exactly one settings row', () => {
    expectProblems(
      check((f) => {
        f.tables.settings = [];
      }),
      'tables.settings must have exactly one row (found 0)',
    );
    expectProblems(
      check((f) => {
        f.tables.settings = [rowOf(f, 'settings'), { ...rowOf(f, 'settings'), id: uuid(300) }];
      }),
      'tables.settings must have exactly one row (found 2)',
    );
  });

  it('requires at least one active, non-deleted manager', () => {
    const cases: ((staff: Row) => void)[] = [
      (s) => {
        s.active = false;
      },
      (s) => {
        s.deletedAt = AT;
      },
      (s) => {
        s.role = 'supervisor';
      },
    ];
    for (const mutate of cases) {
      expectProblems(
        check((f) => {
          mutate(rowOf(f, 'staff'));
        }),
        BACKUP_NO_MANAGER_MESSAGE,
      );
    }
    const withSecondManager = check((f) => {
      rowOf(f, 'staff').active = false;
      f.tables.staff = [...(f.tables.staff ?? []), { ...rowOf(f, 'staff'), id: uuid(400), active: true }];
    });
    expect(withSecondManager.ok).toBe(true);
  });
});

describe('robustness', () => {
  it('lists at most 10 problems', () => {
    const problems = problemsOf(
      check((f) => {
        f.tables.members = Array.from({ length: 40 }, (_, i) => ({ id: `bad-${i}` }));
      }),
    );
    expect(MAX_BACKUP_PROBLEMS).toBe(10);
    expect(problems).toHaveLength(10);
  });

  it('never throws on junk rows', () => {
    const junk: unknown[] = [null, 42, 'row', [], [1, 2], { detail: null }, true];
    const result = check((f) => {
      for (const table of [...ENTITY_NAMES, 'outbox']) f.tables[table] = junk as Row[];
    });
    expect(problemsOf(result).length).toBeGreaterThan(0);
    expect(problemsOf(result).length).toBeLessThanOrEqual(MAX_BACKUP_PROBLEMS);
  });
});

describe('buildOutboxEntry (D-054)', () => {
  it('wraps a stored record as an unsynced outbox entry', () => {
    const category = { ...base(IDS.category), name: 'Draught', sortOrder: 1, colour: '#b45309' } as unknown as Category;
    expect(buildOutboxEntry('categories', 'update', category, AT, uuid(500))).toEqual({
      id: uuid(500),
      entity: 'categories',
      entityId: IDS.category,
      operation: 'update',
      payload: category,
      createdAt: AT,
      syncedAt: null,
    });
  });
});
