// Prometheus text parsing + Kuma /metrics -> monitored-item snapshot.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePrometheusText } = require('../services/prometheusText');
const { snapshotFromMetrics } = require('../services/integrations/uptimeKuma');

const METRICS = `
# HELP monitor_status Monitor Status (1 = UP, 0= DOWN, 2= PENDING, 3= MAINTENANCE)
# TYPE monitor_status gauge
monitor_status{monitor_id="7",monitor_name="resolvd-backend",monitor_type="docker",monitor_url="https://",monitor_hostname="null",monitor_port="null"} 1
monitor_status{monitor_id="9",monitor_name="Site \\"A\\"",monitor_type="http",monitor_url="https://example.com",monitor_hostname="null",monitor_port="null"} 0
monitor_status{monitor_id="30",monitor_name="netbox",monitor_type="group",monitor_url="https://",monitor_hostname="null",monitor_port="null"} 1
monitor_status{monitor_id="11",monitor_name="SMTP",monitor_type="port",monitor_url="https://",monitor_hostname="mail.local",monitor_port="25"} 3
monitor_uptime_ratio{monitor_id="9",monitor_name="Site \\"A\\"",monitor_type="http",window="1d"} 0.9875
monitor_uptime_ratio{monitor_id="9",monitor_name="Site \\"A\\"",monitor_type="http",window="30d"} 0.999
monitor_response_time{monitor_id="9",monitor_name="Site \\"A\\"",monitor_type="http"} 231.4
monitor_response_time{monitor_id="7",monitor_name="resolvd-backend",monitor_type="docker"} -1
monitor_cert_days_remaining{monitor_id="9",monitor_name="Site \\"A\\"",monitor_type="http"} 41
process_cpu_seconds_total 12.5
`;

describe('parsePrometheusText', () => {
  it('parses labels (with escaped quotes) and values, skipping comments', () => {
    const samples = parsePrometheusText(METRICS);
    const site = samples.find((s) => s.name === 'monitor_status' && s.labels.monitor_id === '9');
    expect(site.labels.monitor_name).toBe('Site "A"');
    expect(site.value).toBe(0);
    expect(samples.find((s) => s.name === 'process_cpu_seconds_total').value).toBe(12.5);
    expect(samples.some((s) => s.name.startsWith('#'))).toBe(false);
  });
});

describe('snapshotFromMetrics', () => {
  const rows = snapshotFromMetrics(parsePrometheusText(METRICS));
  const byId = Object.fromEntries(rows.map((r) => [r.external_id, r]));

  it('keeps group monitors as services and skips non-monitor metrics', () => {
    expect(Object.keys(byId).sort()).toEqual(['11', '30', '7', '9']);
    expect(byId['30'].item_type).toBe('group');
  });

  it('maps status codes to states', () => {
    expect(byId['7'].state).toBe('up');
    expect(byId['9'].state).toBe('down');
    expect(byId['11'].state).toBe('maintenance');
  });

  it('keys items like the webhook path', () => {
    expect(byId['9'].item_key).toBe('monitor:9');
  });

  it('collects uptime, response time and cert days', () => {
    expect(byId['9'].uptime_1d).toBeCloseTo(0.9875);
    expect(byId['9'].uptime_30d).toBeCloseTo(0.999);
    expect(byId['9'].response_ms).toBe(231);
    expect(byId['9'].cert_days).toBe(41);
    expect(byId['7'].response_ms).toBeNull();
  });

  it('builds detail from URL or host:port, ignoring Kuma placeholder values', () => {
    expect(byId['9'].detail).toBe('http · https://example.com');
    expect(byId['11'].detail).toBe('port · mail.local:25');
    expect(byId['7'].detail).toBeNull();
  });
});

describe('rollupServiceState', () => {
  const { rollupServiceState } = require('../services/monitoredItems');
  const c = (state, is_primary = false) => ({ state, is_primary });

  it('is down when a primary component is down', () => {
    expect(rollupServiceState([c('down', true), c('up'), c('up')])).toBe('down');
  });
  it('is a partial outage when only a supporting component is down', () => {
    expect(rollupServiceState([c('up', true), c('down'), c('up')])).toBe('partial');
  });
  it('without a primary: one down is partial, all down is down', () => {
    expect(rollupServiceState([c('down'), c('up')])).toBe('partial');
    expect(rollupServiceState([c('down'), c('down')])).toBe('down');
  });
  it('ignores components in maintenance; all in maintenance is maintenance', () => {
    expect(rollupServiceState([c('maintenance', true), c('up')])).toBe('up');
    expect(rollupServiceState([c('maintenance'), c('maintenance')])).toBe('maintenance');
  });
  it('falls back to the service own state with no components', () => {
    expect(rollupServiceState([], 'down')).toBe('down');
  });
});

describe('uptime-kuma mapper — service parent', () => {
  const { PRESETS } = require('../services/alertMappers');
  it('carries the Kuma group as parent', () => {
    const e = PRESETS['uptime-kuma'].mapper({
      heartbeat: { status: 0, time: 't' },
      monitor: { id: 33, parent: 12, name: 'doccontrol-db', path: ['doccontrol-docker', 'doccontrol-db'], type: 'docker' },
    });
    expect(e.parent_key).toBe('monitor:12');
    expect(e.parent_label).toBe('doccontrol-docker');
  });
});
