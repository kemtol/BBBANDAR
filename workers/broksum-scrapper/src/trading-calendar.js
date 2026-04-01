// Shared trading-calendar helpers for broksum-scrapper modules.
// Keep this as the single source of truth to avoid holiday drift.

export const IDX_HOLIDAYS = new Set([
    // 2025
    '2025-01-01', '2025-01-27', '2025-01-28', '2025-03-28', '2025-03-31',
    '2025-04-01', '2025-04-18', '2025-05-01', '2025-05-12', '2025-05-29',
    '2025-06-01', '2025-06-06', '2025-06-27', '2025-09-05',
    '2025-12-25', '2025-12-26',
    // 2026
    '2026-01-01', '2026-02-16', '2026-02-17', '2026-03-11',
    '2026-03-18', '2026-03-19', '2026-03-20', '2026-03-23', '2026-03-24',
    '2026-04-01', '2026-04-02', '2026-04-03', '2026-04-10', '2026-05-01',
    '2026-05-21', '2026-06-01', '2026-06-08', '2026-06-29', '2026-08-17',
    '2026-09-08', '2026-12-25', '2026-12-26',
]);

export function isWeekendUTC(dateStr) {
    const d = new Date(`${dateStr}T12:00:00Z`);
    const dow = d.getUTCDay();
    return dow === 0 || dow === 6;
}

export function isHolidayUTC(dateStr) {
    return IDX_HOLIDAYS.has(dateStr);
}

export function isNonTradingDayUTC(dateStr) {
    return isWeekendUTC(dateStr) || isHolidayUTC(dateStr);
}

export function previousTradingDayUTC(fromDateStr) {
    let d = new Date(`${fromDateStr}T12:00:00Z`);
    do {
        d = new Date(d.getTime() - 86400000);
    } while (isNonTradingDayUTC(d.toISOString().slice(0, 10)));
    return d.toISOString().slice(0, 10);
}
