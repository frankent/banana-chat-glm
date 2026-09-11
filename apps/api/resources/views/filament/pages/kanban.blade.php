<x-filament-panels::page>
    <x-filament::section heading="Workspace board" description="Every workspace has its own board. Members share tickets; administrators configure the workflow here.">
        <label for="kanban-workspace">Workspace</label>
        <select id="kanban-workspace" wire:model.live="workspaceId" class="fi-input block w-full rounded-lg border-gray-300 dark:bg-gray-900">
            @foreach($this->workspaces() as $workspace)<option value="{{ $workspace->id }}">{{ $workspace->name }}</option>@endforeach
        </select>
    </x-filament::section>
    @foreach($lanes as $index=>$lane)
        <x-filament::section wire:key="lane-{{ $lane['id'] }}">
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;align-items:end">
                <label>Name<input aria-label="Lane name {{ $index + 1 }}" wire:model="lanes.{{ $index }}.name" class="block w-full rounded-lg border-gray-300 dark:bg-gray-900" /></label>
                <label>Color<input type="color" wire:model="lanes.{{ $index }}.color" class="block" /></label>
                <label>Position (0 first)<input type="number" min="0" max="100" wire:model="lanes.{{ $index }}.position" class="block w-full rounded-lg border-gray-300 dark:bg-gray-900" /></label>
                <label><input type="checkbox" wire:model="lanes.{{ $index }}.is_done" /> Completed lane<br/><small>Stops deadline reminders</small></label>
                <div style="display:flex;gap:8px;align-items:center"><x-filament::button wire:click="save({{ $index }})">Save</x-filament::button><x-filament::button color="danger" wire:click="remove({{ $index }})" wire:confirm="Delete this empty lane?">Delete</x-filament::button></div>
            </div>
        </x-filament::section>
    @endforeach
    @if($workspaceId)
        <form wire:submit="add" class="flex items-center gap-3"><input aria-label="New lane name" placeholder="New lane name" wire:model="newName" class="rounded-lg border-gray-300 dark:bg-gray-900" /><x-filament::button type="submit">Add lane</x-filament::button>@error('newName')<span>{{ $message }}</span>@enderror</form>
    @endif
</x-filament-panels::page>
