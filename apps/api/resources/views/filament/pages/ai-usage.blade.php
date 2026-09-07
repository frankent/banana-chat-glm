<x-filament-panels::page>
    <div class="max-w-xs">
        <label class="mb-1 block text-xs text-gray-500">เดือน</label>
        <select
            wire:model.live="month"
            class="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
        >
            @foreach ($this->monthOptions() as $value => $label)
                <option value="{{ $value }}">{{ $label }}</option>
            @endforeach
        </select>
    </div>

    @php($summary = $this->summary())
    <div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        @foreach([
            'messages' => 'ข้อความ',
            'tokens_in' => 'Tokens in',
            'tokens_out' => 'Tokens out',
            'tokens_memory' => 'Tokens memory',
            'failed' => 'ล้มเหลว',
        ] as $key => $label)
            <div class="rounded-xl bg-gray-50 p-3 dark:bg-gray-900">
                <div class="text-xs text-gray-500">{{ $label }}</div>
                <div class="mt-1 text-xl font-bold">{{ number_format($summary[$key]) }}</div>
            </div>
        @endforeach
        @php($cost = $this->estimatedCost())
        <div class="rounded-xl bg-gray-50 p-3 dark:bg-gray-900">
            <div class="text-xs text-gray-500">ต้นทุนประมาณการ</div>
            <div class="mt-1 text-xl font-bold">{{ $cost ?? '—' }}</div>
        </div>
    </div>

    <div class="mt-6 grid gap-6 lg:grid-cols-2">
        <div>
            <h3 class="mb-2 text-sm font-semibold">ต่อ workspace</h3>
            <table class="w-full text-sm">
                <thead>
                    <tr class="text-left text-xs text-gray-500">
                        <th class="py-1">Workspace</th>
                        <th class="py-1">ข้อความ</th>
                        <th class="py-1">Tokens</th>
                    </tr>
                </thead>
                <tbody>
                    @forelse ($this->byWorkspace() as $row)
                        <tr class="border-t border-gray-100 dark:border-gray-800">
                            <td class="py-1.5">{{ $row['label'] }}</td>
                            <td class="py-1.5">{{ number_format($row['messages']) }}</td>
                            <td class="py-1.5">{{ number_format($row['tokens']) }}</td>
                        </tr>
                    @empty
                        <tr><td colspan="3" class="py-2 text-gray-400">ไม่มีข้อมูลเดือนนี้</td></tr>
                    @endforelse
                </tbody>
            </table>
        </div>

        <div>
            <h3 class="mb-2 text-sm font-semibold">Top 20 users</h3>
            <table class="w-full text-sm">
                <thead>
                    <tr class="text-left text-xs text-gray-500">
                        <th class="py-1">ผู้ใช้</th>
                        <th class="py-1">ข้อความ</th>
                        <th class="py-1">Tokens</th>
                    </tr>
                </thead>
                <tbody>
                    @forelse ($this->topUsers() as $row)
                        <tr class="border-t border-gray-100 dark:border-gray-800">
                            <td class="py-1.5">{{ $row['name'] }}</td>
                            <td class="py-1.5">{{ number_format($row['messages']) }}</td>
                            <td class="py-1.5">{{ number_format($row['tokens']) }}</td>
                        </tr>
                    @empty
                        <tr><td colspan="3" class="py-2 text-gray-400">ไม่มีข้อมูลเดือนนี้</td></tr>
                    @endforelse
                </tbody>
            </table>
        </div>
    </div>

    <div class="mt-6">
        <h3 class="mb-2 text-sm font-semibold">สุขภาพ model (error rate · first-token p50/p95)</h3>
        <table class="w-full text-sm">
            <thead>
                <tr class="text-left text-xs text-gray-500">
                    <th class="py-1">Model</th>
                    <th class="py-1">Attempts</th>
                    <th class="py-1">Failed</th>
                    <th class="py-1">Error rate</th>
                    <th class="py-1">p50 (ms)</th>
                    <th class="py-1">p95 (ms)</th>
                </tr>
            </thead>
            <tbody>
                @forelse ($this->providerHealth() as $row)
                    <tr class="border-t border-gray-100 dark:border-gray-800">
                        <td class="py-1.5">{{ $row->model ?? '—' }}</td>
                        <td class="py-1.5">{{ number_format($row->attempts) }}</td>
                        <td class="py-1.5">{{ number_format($row->failed) }}</td>
                        <td class="py-1.5">{{ $row->attempts > 0 ? round($row->failed / $row->attempts * 100, 1) : 0 }}%</td>
                        <td class="py-1.5">{{ number_format($row->p50) }}</td>
                        <td class="py-1.5">{{ number_format($row->p95) }}</td>
                    </tr>
                @empty
                    <tr><td colspan="6" class="py-2 text-gray-400">ไม่มีข้อมูลเดือนนี้</td></tr>
                @endforelse
            </tbody>
        </table>
    </div>
</x-filament-panels::page>
