import { readFileSync } from 'node:fs';
export class MemoryPolicy {
  constructor({ warm = 5, max = 7, renderMax = warm, pressureMax = Math.min(2,renderMax), reserveMB = 160, pageMB = 100, budgetMB = 650, read = readFileSync } = {}) {
    Object.assign(this, { warm, max, renderMax, pressureMax, reserveMB, pageMB, budgetMB, read }); this.at = 0; this.sample = {};
  }
  snapshot() {
    if (Date.now() - this.at < 200) return this.sample;
    this.at = Date.now();
    try {
      const available = +(this.read('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m)?.[1] || 0) / 1024;
      let used = 0;
      let group;
      try {
        group = this.read('/proc/self/cgroup', 'utf8').trim().split('\n').find(line => line.startsWith('0::')).slice(3);
        used = +this.read('/sys/fs/cgroup' + group + '/memory.current', 'utf8') / 1048576;
      } catch { used = this.budgetMB; } // Unknown budget: queue, rather than guessing free memory.
      const pressure=name=>{try{return Number(this.read('/sys/fs/cgroup'+group+'/'+name+'.pressure','utf8').match(/^some avg10=([\d.]+)/m)?.[1] ?? NaN);}catch{return NaN;}};
      const io=pressure('io'), memory=pressure('memory'),cpu=pressure('cpu');
      const pressured=!Number.isFinite(io)||!Number.isFinite(memory)||!Number.isFinite(cpu)||io>=10||memory>=1||cpu>=25||
        available<this.reserveMB+this.pageMB||used+this.pageMB>=this.budgetMB;
      this.sample = { available_mb: Math.round(available), service_mb: Math.round(used),
        io_pressure_avg10: Number.isFinite(io)?io:null, memory_pressure_avg10:Number.isFinite(memory)?memory:null,cpu_pressure_avg10:Number.isFinite(cpu)?cpu:null,
        render_limit:pressured?Math.min(this.pressureMax,this.renderMax):this.renderMax,
        temporary_allowed: !pressured && available >= this.reserveMB + this.pageMB && used + this.pageMB < this.budgetMB };
    } catch { this.sample = { available_mb: null, service_mb: null, render_limit:Math.min(this.pressureMax,this.renderMax), temporary_allowed: false }; }
    return this.sample;
  }
  renderLimit() { return this.snapshot().render_limit; }
  capacity(active) {
    const state = this.snapshot(), extra = Math.max(1, active - this.warm + 1);
    return active >= this.warm && state.temporary_allowed &&
      state.available_mb >= this.reserveMB + extra * this.pageMB &&
      state.service_mb + extra * this.pageMB < this.budgetMB ? Math.min(this.max, active + 1) : this.warm;
  }
}
