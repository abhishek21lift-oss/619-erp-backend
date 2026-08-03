'use strict';

module.exports = {

    provider: process.env.AI_PROVIDER || 'openrouter',

    openrouter: {
        apiUrl: 'https://openrouter.ai/api/v1/chat/completions',

        primaryModel:
            process.env.AI_PRIMARY_MODEL ||
            'nvidia/nemotron-3-ultra-550b-a55b:free',

        secondaryModel:
            process.env.AI_SECONDARY_MODEL ||
            'nvidia/nemotron-3-super-120b-a12b:free',

        fallbackModel:
            process.env.AI_FALLBACK_MODEL ||
            'openai/gpt-oss-20b:free',

        apiKey: process.env.OPENROUTER_API_KEY
    }

};