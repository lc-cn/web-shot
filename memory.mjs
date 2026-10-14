import { readFileSync } from 'node:fs';
export class MemoryPolicy {
  constructor({ warm = 5, max = 7, reserveMB = 160, pageMB = 100, budgetMB = 650, read = readFileSync } = {}) {
    Object.assign(this, { warm, max, reserveMB, pageMB, budgetMB, read }); this.at = 0; this.sample = {};
  }
  snapshot() {
    if (Date.now() - this.at < 200) return this.sample;
    this.at = Date.now();
    try {
      const available = +(this.read('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m)?.[1] || 0) / 1024;
      let used = 0;
      try {
        const group = this.read('/proc/self/cgroup', 'utf8').trim().split('\n').find(line => line.startsWith('0::')).slice(3);
        used = +this.read('/sys/fs/cgroup' + group + '/memory.current', 'utf8') / 1048576;
      } catch { used = this.budgetMB; } // Unknown budget: queue, rather than guessing free memory.
      this.sample = { available_mb: Math.round(available), service_mb: Math.round(used),
        temporary_allowed: available >= this.reserveMB + this.pageMB && used + this.pageMB < this.budgetMB };
    } catch { this.sample = { available_mb: null, service_mb: null, temporary_allowed: false }; }
    return this.sample;
  }
  capacity(active) {
    const state = this.snapshot(), extra = Math.max(1, active - this.warm + 1);
    return active >= this.warm && state.temporary_allowed &&
      state.available_mb >= this.reserveMB + extra * this.pageMB &&
      state.service_mb + extra * this.pageMB < this.budgetMB ? Math.min(this.max, active + 1) : this.warm;
  }
}
