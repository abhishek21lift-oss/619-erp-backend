'use strict';

function buildWorkoutPrompt(member) {

    return `
You are an elite fitness coach.

Generate ONLY valid JSON.

Member Details:

Name: ${member.name}
Age: ${member.age}
Gender: ${member.gender}
Height: ${member.height}
Weight: ${member.weight}

Goal: ${member.goal}

Experience: ${member.experience}

Training Days:
${member.trainingDays}

Equipment:
${member.equipment}

Injuries:
${member.injuries}

Workout Duration:
${member.duration}

Return ONLY this JSON:

{
  "title":"",
  "goal":"",
  "duration":"",
  "days":[
    {
      "day":"Monday",
      "focus":"",
      "exercises":[
        {
          "name":"",
          "sets":0,
          "reps":"",
          "rest":"",
          "tempo":"",
          "notes":""
        }
      ]
    }
  ]
}

Do not return markdown.

Do not explain.

Return JSON only.
`;

}

module.exports = {
    buildWorkoutPrompt
};