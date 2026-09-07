<?php

namespace App\Domain\Ai;

/**
 * FR-AI-019 — provider failures mapped to spec error codes.
 */
class AiProviderException extends \RuntimeException
{
    public function __construct(
        public readonly string $errorCode, // AI_PROVIDER_ERROR | AI_PROVIDER_TIMEOUT | AI_CONTEXT_OVERFLOW
        string $message,
        public readonly ?string $providerDetail = null,
    ) {
        parent::__construct($message);
    }
}
