const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function formatDate(value) {
  if (!value) return 'Not set';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not set';
  return dateFormat.format(date);
}

export function formatDateTime(value) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not recorded';
  return dateTimeFormat.format(date);
}

export function formatRelative(value) {
  if (!value) return 'unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const divisions = [
    { amount: 60, unit: 'second' },
    { amount: 60, unit: 'minute' },
    { amount: 24, unit: 'hour' },
    { amount: 7, unit: 'day' },
    { amount: 4.345, unit: 'week' },
    { amount: 12, unit: 'month' },
    { amount: Infinity, unit: 'year' },
  ];
  let duration = diffSeconds;
  for (const division of divisions) {
    if (Math.abs(duration) < division.amount) {
      return relativeFormat.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return formatDate(value);
}

export function daysUntil(value) {
  if (!value) return null;
  const diff = new Date(value).getTime() - Date.now();
  return Math.ceil(diff / 86_400_000);
}

export function initials(name = '') {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

export function titleCase(value = '') {
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function truncate(value = '', max = 120) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

export function pluralize(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural || `${singular}s`}`;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

export function percent(value) {
  return `${Math.round((value || 0) * 100)}%`;
}

export function safeName(value = '') {
  return value.replace(/[^\w.-]+/g, '-');
}
