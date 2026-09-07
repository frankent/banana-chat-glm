@php($models = cache()->get("ai-provider-models:".($record?->id ?? 'new')) ?? [])
<div class="text-sm">
    @if ($models === [])
        <p class="text-gray-500">กดปุ่ม "โหลดรายการโมเดล" ในหน้ารายการก่อน (เก็บ 30 นาที)</p>
    @else
        <ul class="list-disc pl-5 space-y-0.5">
            @foreach ($models as $m)
                <li><code>{{ $m }}</code></li>
            @endforeach
        </ul>
    @endif
</div>
