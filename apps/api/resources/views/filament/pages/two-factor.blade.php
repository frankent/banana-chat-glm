<x-filament-panels::page>
    @if ($this->isEnabled())
        <x-filament::section>
            <x-slot name="heading">2FA เปิดใช้งานอยู่</x-slot>
            <x-slot name="description">
                การเข้าสู่ระบบ admin panel ต้องกรอกรหัส 6 หลักจากแอป Authenticator ทุกครั้ง (NFR-SEC-012)
            </x-slot>

            <x-filament::button color="danger" wire:click="disable">
                ปิดใช้งาน 2FA
            </x-filament::button>
        </x-filament::section>
    @else
        <x-filament::section>
            <x-slot name="heading">เปิดใช้ 2FA (TOTP)</x-slot>
            <x-slot name="description">
                เพิ่มความปลอดภัยให้บัญชี system admin — TASK-ADM-011
            </x-slot>

            @if ($pendingSecret)
                <div class="space-y-2">
                    <p class="text-sm text-gray-600 dark:text-gray-300">เพิ่มรหัสลับนี้ในแอป Authenticator แล้วกรอกรหัส 6 หลักเพื่อยืนยัน:</p>
                    <code class="block rounded-lg bg-gray-100 p-3 font-mono text-lg tracking-widest break-all dark:bg-gray-800">{{ $pendingSecret }}</code>
                    <a href="{{ $this->pendingOtpauthUri(app(\App\Domain\Admin\TotpService::class)) }}"
                       class="text-sm text-primary-600 underline break-all dark:text-primary-400">
                        {{ $this->pendingOtpauthUri(app(\App\Domain\Admin\TotpService::class)) }}
                    </a>
                </div>

                {{ $this->form }}

                <div class="mt-4 flex gap-2">
                    <x-filament::button wire:click="confirm">
                        ยืนยันและเปิดใช้งาน
                    </x-filament::button>
                    <x-filament::button color="gray" wire:click="generateSecret">
                        สร้างรหัสลับใหม่
                    </x-filament::button>
                </div>
            @else
                <x-filament::button wire:click="generateSecret">
                    เริ่มต้น — สร้างรหัสลับ
                </x-filament::button>
            @endif
        </x-filament::section>
    @endif
</x-filament-panels::page>
