'use strict';

const openrouter = require('../providers/openrouter.provider');

class AIGateway {

    async chat(messages) {

        return await openrouter.chat(messages);

    }

}

module.exports = new AIGateway();