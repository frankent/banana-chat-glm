<?php

namespace App\Events;

use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;

/**
 * EVT-011 on the wire — the same `message.updated` clients already render,
 * published synchronously.
 *
 * The room bot writes its answer a few words at a time, so each frame is only
 * useful while it is still ahead of the model. Going through the queue for a
 * frame that is superseded half a second later adds a hop for nothing; Reverb
 * sits on the same Docker network, so publishing inline costs a few ms inside
 * a job that is already waiting on the provider.
 *
 * Ordinary edits keep using MessageUpdated: they happen once, and a queued
 * broadcast is the right shape for them.
 */
class MessageStreamed extends MessageUpdated implements ShouldBroadcastNow {}
