import path from 'node:path';
import * as XLSX from 'xlsx';

/**
 * makeSampleXlsx.ts  (`npm run gen:xlsx`)
 *
 * Generates shared/sample-rules-upload.xlsx: an Excel mirror of the 12 canonical
 * stage-2 "Risk Assessment" rules so business users can immediately test the
 * Admin UI Excel import flow (POST /api/rules/upload-excel).
 *
 * Condition columns hold literal Zen unary-test text (e.g. ">= 28",
 * contains($, "FATTY_LIVER")); blank means "any". ExclusionCode "-" means null.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_FILE = path.join(REPO_ROOT, 'shared', 'sample-rules-upload.xlsx');

const HEADERS = [
  'RuleId', 'Outcome', 'Debits', 'ExclusionCode', 'Reason',
  'Age', 'BMI', 'SystolicBP', 'Smoker', 'IncomeMultiple',
  'SurgeryMonthsAgo', 'MedicalConditions', 'OccupationClass', 'Avocations',
];

// Mirrors node-step2-risk-assessment.content.rules in shared/rules/v1-migrated-rules.json.
const ROWS: (string | number)[][] = [
  ['RA_AGE_KNOCKOUT', 'DECLINE', 999, '-', 'Age outside insurable range 18-65', '< 18 or > 65', '', '', '', '', '', '', '', ''],
  ['RA_BP_CRISIS', 'DECLINE', 999, '-', 'Hypertensive crisis (Systolic BP >= 180)', '', '', '>= 180', '', '', '', '', '', ''],
  ['RA_EXTREME_BMI', 'DECLINE', 999, '-', 'Severe obesity BMI >= 38', '', '>= 38', '', '', '', '', '', '', ''],
  ['RA_FINANCIAL_OVERINSURED', 'DECLINE', 999, '-', 'Sum assured exceeds 25x annual income', '', '', '', '', '> 25', '', '', '', ''],
  ['RA_RECENT_SURGERY', 'POSTPONE', 0, '-', 'Major surgery within last 6 months; postpone until recovery', '', '', '', '', '', '> 0 and <= 6', '', '', ''],
  ['RA_BENIGN_THYROID', 'EXCLUSION', 0, 'EXCL_THYROID_GLAND', 'TI-RADS 2/3 thyroid nodule requires thyroid exclusion rider', '', '', '', '', '', '', 'contains($, "THYROID_NODULE_BENIGN")', '', ''],
  ['RA_MILD_OVERWEIGHT', 'DEBIT', 15, '-', 'Mild overweight (BMI 25.0-27.9)', '', '>= 25 and < 28', '', '', '', '', '', '', ''],
  ['RA_OBESITY_CLASS_1', 'DEBIT', 40, '-', 'Obesity Class I/II (BMI 28.0-37.9)', '', '>= 28 and < 38', '', '', '', '', '', '', ''],
  ['RA_HYPERTENSION_S1', 'DEBIT', 35, '-', 'Stage 1 Hypertension (140-159 mmHg)', '', '', '>= 140 and < 160', '', '', '', '', '', ''],
  ['RA_HYPERTENSION_S2', 'DEBIT', 80, '-', 'Stage 2 Hypertension (160-179 mmHg)', '', '', '>= 160 and < 180', '', '', '', '', '', ''],
  ['RA_SMOKER_BP_SYNERGY', 'UNCLEAN_DEBIT', 30, '-', 'Synergistic cardiovascular risk: Smoker + Hypertension', '', '', '>= 140 and < 180', 'true', '', '', '', '', ''],
  ['RA_METABOLIC_COMORBIDITY', 'UNCLEAN_DEBIT', 0, '-', 'Metabolic comorbidity: BMI >= 28 with Fatty Liver requires underwriter review', '', '>= 28', '', '', '', '', 'contains($, "FATTY_LIVER")', '', ''],
];

function main() {
  const worksheet = XLSX.utils.aoa_to_sheet([HEADERS, ...ROWS]);
  worksheet['!cols'] = HEADERS.map((h) => ({ wch: h === 'Reason' ? 64 : Math.max(12, h.length) }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'RiskAssessment');
  XLSX.writeFile(workbook, OUT_FILE);
  console.log(`Wrote sample Excel decision table (${ROWS.length} rows) -> ${path.relative(process.cwd(), OUT_FILE)}`);
}

main();
