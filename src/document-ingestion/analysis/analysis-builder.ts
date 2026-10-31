export type IssueSeverity = 'CRITICAL' | 'ERROR' | 'WARNING';
export type AnalysisVerdict = 'READY' | 'MERGE_WITH_CORRECTIONS' | 'REUPLOAD_REQUIRED';
export type AnalysisSeverity = 'CLEAN' | 'MINOR' | 'MODERATE' | 'SEVERE';

export interface AnalysisIssue {
  severity: IssueSeverity;
  title: string;
  message: string;
  sheet?: string;
  row?: number;
}

export interface AnalysisIssueGroup {
  severity: IssueSeverity;
  title: string;
  count: number;
  // A sample of where to look in the file, for the user correcting it.
  locations: string[];
}

export interface AnalysisSheet {
  name: string;
  recognized: boolean;
  rows: number;
  validRows: number;
}

export interface DocumentAnalysis {
  verdict: AnalysisVerdict;
  severity: AnalysisSeverity;
  canMerge: boolean;
  recommendation: string;
  totalRows: number;
  validRows: number;
  rowsToCreate: number;
  rowsToUpdate: number;
  rowsToSkip: number;
  rowsWithWarnings: number;
  sheets: AnalysisSheet[];
  issueGroups: AnalysisIssueGroup[];
  issues: AnalysisIssue[];
  issuesTruncated: boolean;
}

// The stored analysis is a JSON column polled by the wizard; a badly broken file
// can raise an issue per cell, and the groups already carry the full counts.
export const MAX_STORED_ISSUES = 500;
export const REUPLOAD_REJECTED_RATIO = 0.5;
const MODERATE_REJECTED_RATIO = 0.05;

const MAX_GROUP_LOCATIONS = 5;

const SEVERITY_ORDER: Record<IssueSeverity, number> = { CRITICAL: 0, ERROR: 1, WARNING: 2 };

// Row messages can quote a rejected BVN or similar; this analysis is stored and
// shown to whoever reviews the upload, so long digit runs never go in verbatim.
function maskLongDigitRuns(message: string): string {
  return message.replace(/\d{10,}/g, '***');
}

// Groups issues by their wording with quoted values removed, so a thousand
// `BVN "..." is not 11 digits` rows read as one finding.
function toTitle(message: string): string {
  const stripped = message.replace(/\s*"[^"]*"/g, '').trim();
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

export class AnalysisBuilder {
  private readonly issues: AnalysisIssue[] = [];
  private readonly groups = new Map<string, AnalysisIssueGroup>();
  private readonly sheets: AnalysisSheet[] = [];
  private readonly warnedRows = new Set<string>();
  private totalRows = 0;
  private validRows = 0;
  private rowsToCreate = 0;
  private rowsToUpdate = 0;
  private hasCritical = false;

  addSheet(name: string, recognized: boolean): AnalysisSheet {
    const sheet = { name, recognized, rows: 0, validRows: 0 };
    this.sheets.push(sheet);
    return sheet;
  }

  addIssue(severity: IssueSeverity, message: string, location: { sheet?: string; row?: number } = {}): void {
    const title = toTitle(message);
    const group = this.groups.get(title) ?? { severity, title, count: 0, locations: [] };
    this.groups.set(title, group);
    group.count++;
    if (location.sheet !== undefined && group.locations.length < MAX_GROUP_LOCATIONS) {
      group.locations.push(location.row === undefined ? location.sheet : `${location.sheet} row ${location.row}`);
    }

    if (severity === 'CRITICAL') this.hasCritical = true;
    if (severity === 'WARNING' && location.row !== undefined) {
      this.warnedRows.add(`${location.sheet ?? ''}::${location.row}`);
    }
    this.issues.push({ severity, title, message: maskLongDigitRuns(message), ...location });
  }

  countRow(sheet: AnalysisSheet | null): void {
    this.totalRows++;
    if (sheet) sheet.rows++;
  }

  countValidRow(sheet: AnalysisSheet | null, isUpdate: boolean): void {
    this.validRows++;
    if (sheet) sheet.validRows++;
    if (isUpdate) {
      this.rowsToUpdate++;
    } else {
      this.rowsToCreate++;
    }
  }

  build(): DocumentAnalysis {
    if (this.totalRows === 0 && !this.hasCritical) {
      this.addIssue('CRITICAL', 'No data rows were found in this file');
    }

    const rowsToSkip = this.totalRows - this.validRows;
    const rejectedRatio = this.totalRows === 0 ? 0 : rowsToSkip / this.totalRows;
    const hasWarnings = [...this.groups.values()].some((group) => group.severity === 'WARNING');

    let verdict: AnalysisVerdict;
    let severity: AnalysisSeverity;
    let recommendation: string;
    if (this.hasCritical || rejectedRatio >= REUPLOAD_REJECTED_RATIO) {
      verdict = 'REUPLOAD_REQUIRED';
      severity = 'SEVERE';
      recommendation = this.hasCritical
        ? 'This file cannot be merged. Check the problems below in your file, correct them or start again from the template, then upload it again.'
        : `${rowsToSkip} of ${this.totalRows} rows would be rejected, so this is probably the wrong file or format. Check it against the template, correct it and upload it again.`;
    } else if (rowsToSkip > 0) {
      verdict = 'MERGE_WITH_CORRECTIONS';
      severity = rejectedRatio >= MODERATE_REJECTED_RATIO ? 'MODERATE' : 'MINOR';
      recommendation = `${this.validRows} rows can be merged and ${rowsToSkip} will be skipped. Check the rows listed below in your file, correct them and upload it again, or merge now and upload the corrected rows later.`;
    } else if (hasWarnings) {
      verdict = 'MERGE_WITH_CORRECTIONS';
      severity = 'MINOR';
      recommendation = 'Every row can be merged, but some data is incomplete. Check the rows listed below in your file and upload it again, or merge as it is.';
    } else {
      verdict = 'READY';
      severity = 'CLEAN';
      recommendation = 'No problems found. This file is ready to merge.';
    }

    const sorted = [...this.issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    return {
      verdict,
      severity,
      canMerge: verdict !== 'REUPLOAD_REQUIRED',
      recommendation,
      totalRows: this.totalRows,
      validRows: this.validRows,
      rowsToCreate: this.rowsToCreate,
      rowsToUpdate: this.rowsToUpdate,
      rowsToSkip,
      rowsWithWarnings: this.warnedRows.size,
      sheets: this.sheets,
      issueGroups: [...this.groups.values()].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count),
      issues: sorted.slice(0, MAX_STORED_ISSUES),
      issuesTruncated: sorted.length > MAX_STORED_ISSUES,
    };
  }
}
