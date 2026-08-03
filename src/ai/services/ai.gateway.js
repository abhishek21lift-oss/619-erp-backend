'use strict';

const config = require('../config');
const openrouter = require('../providers/openrouter.provider');

class AIGateway {

    async chat(messages) {

        const models = [

            config.openrouter.primaryModel,

            config.openrouter.secondaryModel,

            config.openrouter.fallbackModel

        ];

        let lastError;

        for (const model of models) {

            try {

                return await openrouter.chat(messages, model);

            } catch (err) {

                console.warn(`❌ ${model} failed`);

                lastError = err;

            }

        }

        throw lastError;

    }

}

module.exports = new AIGateway();