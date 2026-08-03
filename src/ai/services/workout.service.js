'use strict';

const ai = require('./ai.gateway');
const { buildWorkoutPrompt } = require('../prompts/workout.prompt');

class WorkoutService {

    async generate(member) {

        const prompt = buildWorkoutPrompt(member);

        const response = await ai.chat([
            {
                role: 'system',
                content: 'You are the MY PT STUDIO AI Coach.'
            },
            {
                role: 'user',
                content: prompt
            }
        ]);

        return JSON.parse(response);

    }

}

module.exports = new WorkoutService();