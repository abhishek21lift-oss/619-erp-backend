'use strict';

const config = require('../config');
const request = require('../utils/ai.request');

class OpenRouterProvider {

    async chat(messages, model = null) {

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

        return response.data;

    }

}

module.exports = new OpenRouterProvider();