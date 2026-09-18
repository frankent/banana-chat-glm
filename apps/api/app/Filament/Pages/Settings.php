<?php

namespace App\Filament\Pages;

use App\Domain\Admin\ModerationService;
use App\Services\AuditLogger;
use App\Services\SettingsService;
use Filament\Forms\Components\Section;
use Filament\Forms\Components\TagsInput;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Forms\Form;
use Filament\Notifications\Notification;
use Filament\Pages\Page;
use Illuminate\Support\Facades\DB;

/** FR-ADM-009 / TC-ADM-071: every runtime key, typed and range-validated. */
class Settings extends Page
{
    protected static ?string $navigationIcon = 'heroicon-o-cog-6-tooth';

    protected static ?string $navigationGroup = 'System';

    protected static ?string $title = 'System settings';

    protected static string $view = 'filament.pages.settings';

    public ?array $data = [];

    public function mount(): void
    {
        $this->form->fill(collect(app(SettingsService::class)->all())->undot()->all());
    }

    /** FR-CALL-006 / DEC-057: policy notes shown next to the generated fields. */
    public const HELPERS = [
        'call.max_participants' => 'Maximum participants for NEW group calls and public meeting links (direct rooms stay at 2). Active calls and existing links keep the capacity they were created with.',
        // FR-PCHAT-034 / DEC-067 / DEC-071 — the public chat kill switch. Off is
        // the shipped default because this is an externally reachable,
        // unauthenticated customer surface.
        'publicchat.enabled' => 'Public Chat kill switch. OFF stops writes only: partner create/close and every agent and visitor send return 503, while the visitor page still loads read-only, agent reads and the admin transcripts are unaffected, and no conversation is closed, expired, reassigned or deleted. Re-enabling resumes mid-conversation.',
        'publicchat.link_ttl_days' => 'Lifetime of a /support/<code> visitor link, in days from creation. The link is bearer authority — anyone holding the URL is the visitor — so this value is the main bound on a forwarded or leaked link.',
        'publicchat.max_message_length' => 'Maximum characters in one public chat message (visitor or agent).',
    ];

    public static function ranges(): array
    {
        return [
            'message.max_length' => [1, 32000], 'message.edit_window_minutes' => [0, 525600], 'message.max_attachments' => [1, 20],
            'room.group.max_members' => [2, 10000], 'room.deleted_purge_days' => [1, 365],
            'call.max_participants' => [2, 50],
            'auth.password.min_length' => [8, 128], 'auth.lockout.threshold' => [3, 100], 'auth.lockout.minutes' => [1, 1440],
            'auth.access_token_ttl_minutes' => [5, 1440], 'auth.refresh_token_ttl_days' => [1, 90], 'auth.max_sessions_per_user' => [1, 100],
            'upload.image.max_bytes' => [1024, 1073741824], 'upload.video.max_bytes' => [1024, 2147483647], 'upload.file.max_bytes' => [1024, 2147483647],
            'upload.multipart_threshold_bytes' => [5242880, 1073741824], 'upload.multipart_part_bytes' => [5242880, 1073741824],
            'presence.offline_after_seconds' => [10, 3600], 'typing.ttl_seconds' => [1, 30], 'push.suppress_if_focused_seconds' => [0, 600],
            'storage.quota_per_workspace_gb' => [0.01, 1000000],
            'ai.memory.max_per_user' => [0, 10000], 'ai.memory.inject_max' => [0, 1000], 'ai.memory.inject_max_tokens' => [0, 32000],
            'ai.daily_message_limit_per_user' => [0, 100000], 'ai.max_message_chars' => [1, 128000], 'ai.max_concurrent_per_user' => [1, 20],
            'ai.compaction.trigger_ratio' => [0.1, 0.95], 'ai.stream.flush_interval_ms' => [20, 5000], 'ai.room_bot.history_messages' => [0, 200], 'ai.deleted_purge_days' => [1, 365],
            'ai.push_suppress_if_focused_seconds' => [0, 600],
            // FR-PCHAT-033 — these two MUST exist here for as long as they exist
            // in SettingsService::DEFAULTS. See the guard in form() below: a
            // numeric key with no entry here used to take down the whole
            // settings page, i.e. the very page that turns Public Chat off.
            'publicchat.link_ttl_days' => [1, 365],
            'publicchat.max_message_length' => [1, 32000],
        ];
    }

    public function form(Form $form): Form
    {
        $groups = [];
        foreach (SettingsService::DEFAULTS as $key => $default) {
            $label = ucwords(str_replace(['.', '_'], ' ', $key));
            if (is_bool($default)) {
                $field = Toggle::make($key);
            } elseif (is_array($default)) {
                $field = TagsInput::make($key)->nestedRecursiveRules(['string', 'max:40', 'regex:/^[a-zA-Z0-9.+_-]+$/']);
            } elseif (is_string($default)) {
                $field = TextInput::make($key)->maxLength(40)->regex('/^(?:[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)?$/')->helperText('Leave empty to disable the minimum-version gate.');
            } else {
                // FR-PCHAT-033 / R11 — this used to be a bare
                // `[$min,$max] = self::ranges()[$key]`, so ANY numeric key added
                // to SettingsService::DEFAULTS without a matching ranges() entry
                // threw an "Undefined array key" for every admin and took the
                // whole settings page down — including the Public Chat kill
                // switch that lives on it. A missing range is now a field with
                // no min/max instead of an outage. Add the ranges() entry too:
                // the guard is a seatbelt, not a licence to skip it.
                [$min, $max] = self::ranges()[$key] ?? [null, null];
                $field = TextInput::make($key)->numeric();
                if ($min !== null) {
                    $field->minValue($min);
                }
                if ($max !== null) {
                    $field->maxValue($max);
                }
                if (is_int($default)) {
                    $field->integer();
                }if ($default !== null) {
                    $field->required();
                } else {
                    $field->nullable()->helperText('Leave empty for unlimited storage.');
                }
            }
            if (isset(self::HELPERS[$key])) {
                $field->helperText(self::HELPERS[$key]);
            }
            $groups[explode('.', $key)[0]][] = $field->label($label);
        }
        $sections = [];
        foreach ($groups as $name => $fields) {
            $sections[] = Section::make(ucfirst($name))->schema($fields)->columns(2)->collapsible();
        }

        return $form->schema($sections)->statePath('data');
    }

    public function save(): void
    {
        app(ModerationService::class)->authorize(auth('admin')->user());
        $data = $this->form->getState();
        $settings = app(SettingsService::class);
        $old = [];
        $new = [];
        foreach (SettingsService::DEFAULTS as $key => $default) {
            $v = data_get($data, $key);
            $value = match (true) {
                is_bool($default) => (bool) $v,is_int($default) => (int) $v,is_float($default) => (float) $v,is_array($default) => array_values($v ?? []),$default === null => $v === null || $v === '' ? null : (float) $v,default => (string) ($v ?? '')
            };
            if ($settings->get($key) !== $value) {
                $old[$key] = $settings->get($key);
                $new[$key] = $value;
            }
        }
        DB::transaction(function () use ($settings, $old, $new) {
            foreach ($new as $key => $value) {
                $settings->set($key, $value, auth('admin')->id());
            }app(AuditLogger::class)->log('settings.updated', auth('admin')->user(), 'settings', null, ['changed' => array_keys($new), 'old' => $old, 'new' => $new]);
        });
        $settings->flush();
        Notification::make()->title('Settings saved')->success()->send();
    }
}
