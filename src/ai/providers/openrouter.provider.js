'use strict';

const config = require('../config');
const request = require('../utils/ai.request');

class OpenRouterProvider {

    async chat(messages, model = null) {

        console.log(`Using AI Model: ${model || config.openrouter.primaryModel}`);
        console.log("📤 Sending request to OpenRouter...");
        const response = await request.post(

            config.openrouter.apiUrl,

            {
                model: model || config.openrouter.primaryModel,
                messages
            },

            {
                Authorization: `Bearer ${config.openrouter.apiKey}`,
                "Content-Type": "application/json"
            }

        );
        console.log("📥 Response received from OpenRouter");

        if (!response.data?.choices?.length) {
    throw new Error('No response from AI');
}

return response.data.choices[0].message.content;

    }

}

module.exports = new OpenRouterProvider();