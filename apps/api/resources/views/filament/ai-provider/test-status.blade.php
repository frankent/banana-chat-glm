<div class="space-y-1 text-sm">
    @if ($record?->last_test_status)
        <p>
            ผลล่าสุด ({{ $record->last_tested_at?->format('Y-m-d H:i') }}):
            <span class="fi-badge {{ ($record->last_test_status['ok'] ?? false) ? 'bg-success-500/10 text-success-600' : 'bg-danger-500/10 text-danger-600' }}">
                {{ ($record->last_test_status['ok'] ?? false) ? 'ผ่าน' : 'ไม่ผ่าน' }}
            </span>
            latency {{ $record->last_test_status['latency_ms'] ?? '?' }}ms
        </p>
        @if (! ($record->last_test_status['ok'] ?? false))
            <p class="text-danger-600 break-all">{{ \Illuminate\Support\Str::limit($record->last_test_status['error'] ?? '', 300) }}</p>
        @endif
    @else
        <p class="text-gray-500">ยังไม่เคยทดสอบ — กดปุ่ม "ทดสอบการเชื่อมต่อ" ในหน้ารายการ</p>
    @endif
</div>
