import type { SystemMonitorStatus } from '@suanlizi/protocol';

export function SystemMonitorWidget({ status, zh }: { status: SystemMonitorStatus | null; zh: boolean }) {
  if (!status?.enabled) return null;
  const snapshot = status.snapshot;
  const ready = snapshot.cpuCount > 0 || snapshot.memTotal > 0;
  const disk = snapshot.disks[0];
  const levelLabel = !ready
    ? (zh ? '采样中' : 'Sampling')
    : zh
      ? ({ none: '正常', light: '提醒', moderate: '限制', severe: '严重' } as const)[status.level]
      : ({ none: 'Normal', light: 'Notice', moderate: 'Limited', severe: 'Severe' } as const)[status.level];
  const help = zh
    ? '系统性能采样仅在设置中开启后显示，数据来自当前运行时。'
    : 'System sampling is shown only when enabled in Settings and reflects the current runtime.';
  return (
    <div className="systemMonitorWidget" role="status" aria-label={zh ? '系统性能采样' : 'System performance sampling'}>
      <span className={`systemMonitorWidget__level systemMonitorWidget__level--${status.level}`} title={status.recommendation}>{levelLabel}</span>
      <span className="systemMonitorWidget__metric" title={zh ? 'CPU 使用率' : 'CPU usage'}>CPU {ready ? `${snapshot.cpuUsage.toFixed(0)}%` : '--'}</span>
      <span className="systemMonitorWidget__metric" title={zh ? '内存使用率' : 'Memory usage'}>RAM {ready ? `${snapshot.memUsage.toFixed(0)}%` : '--'}</span>
      {disk ? <span className="systemMonitorWidget__metric" title={zh ? `磁盘可用空间 ${disk.mount}` : `Disk free space ${disk.mount}`}>DISK {disk.size > 0 ? `${Math.round((disk.available / disk.size) * 100)}%` : '--'}</span> : null}
      <span className="systemMonitorHelp" title={help} aria-label={help}>?</span>
    </div>
  );
}
