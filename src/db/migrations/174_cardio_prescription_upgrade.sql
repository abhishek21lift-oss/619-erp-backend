-- ============================================================
-- 174_cardio_prescription_upgrade.sql
--
-- Adds exercise-level prescription guidance and extends the canonical
-- Training OS prescription vocabulary for cardio. The legacy workout_* path
-- remains untouched; Training OS owns the new prescription/performance flow.
--
-- The 14 updates below match source_id, never create/delete/re-key rows, and
-- preserve gif_url and all foreign-key relationships.
-- ============================================================

ALTER TABLE public.exercises
  ADD COLUMN IF NOT EXISTS prescription_mode_primary TEXT,
  ADD COLUMN IF NOT EXISTS prescription_mode_allowed TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE public.workout_template_exercises
  ADD COLUMN IF NOT EXISTS target_cadence SMALLINT,
  ADD COLUMN IF NOT EXISTS target_floors INTEGER,
  ADD COLUMN IF NOT EXISTS target_steps INTEGER;

ALTER TABLE public.workout_template_exercises
  DROP CONSTRAINT IF EXISTS wte_prescription_check;

ALTER TABLE public.workout_template_exercises
  ADD CONSTRAINT wte_prescription_check CHECK (prescription_type IN (
    'SETS_REPS','WEIGHT_REPS','RPE_BASED','RIR_BASED','PERCENT_1RM',
    'TIME','DISTANCE','TIME_DISTANCE','TIME_SPEED','DISTANCE_LOAD','TIME_LOAD',
    'PACE','SPEED','CALORIES','HEART_RATE','RPE','RPM','STEPS','FLOORS','HOLD',
    'INTERVAL','ROUNDS','AMRAP','EMOM','CIRCUIT','BODYWEIGHT','MOBILITY','CUSTOM'
  ));

ALTER TABLE public.cardio_performances
  DROP CONSTRAINT IF EXISTS cp_type_check;

ALTER TABLE public.cardio_performances
  ADD CONSTRAINT cp_type_check CHECK (cardio_type IN (
    'TREADMILL','RUNNING','CYCLING','STATIONARY_BIKE','ROWING','ELLIPTICAL',
    'STAIRMASTER','STEP_MILL','SKI_ERG','SWIMMING','WALKING','SKATING',
    'PROWLER','JUMP_ROPE','HIIT','CIRCUIT','OTHER'
  ));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'exercises_prescription_mode_primary_check'
       AND conrelid = 'public.exercises'::regclass
  ) THEN
    ALTER TABLE public.exercises ADD CONSTRAINT exercises_prescription_mode_primary_check
      CHECK (prescription_mode_primary IS NULL OR prescription_mode_primary IN (
        'REPS','TIME','DISTANCE','SPEED','PACE','TIME_SPEED','TIME_DISTANCE',
        'DISTANCE_LOAD','TIME_LOAD','CALORIES','HEART_RATE','RPE','INTERVAL',
        'ROUNDS','RPM','STEPS','FLOORS','HOLD'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS exercises_prescription_mode_primary_idx
  ON public.exercises (prescription_mode_primary)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN public.exercises.prescription_mode_primary IS
  'Default Training OS prescription type for this exercise; NULL means legacy REPS.';
COMMENT ON COLUMN public.exercises.prescription_mode_allowed IS
  'Training OS prescription types a trainer may select for this exercise.';
COMMENT ON COLUMN public.workout_template_exercises.target_cadence IS
  'Target cadence/RPM for cadence-based prescriptions.';
COMMENT ON COLUMN public.workout_template_exercises.target_floors IS
  'Target floors for stair-climbing prescriptions.';
COMMENT ON COLUMN public.workout_template_exercises.target_steps IS
  'Target steps for step/stair prescriptions.';

-- Cardio rows: explicit modes replace the legacy 3x12 defaults. The master row
-- contains guidance only; actual targets belong to workout_template_exercises.
UPDATE public.exercises SET
  prescription_mode_primary = v.primary_mode,
  prescription_mode_allowed = v.allowed_modes,
  sets_default = NULL,
  reps_default = NULL,
  rest_seconds = NULL,
  recommended_sets = NULL,
  recommended_reps = NULL,
  description = v.description,
  instructions = v.instructions,
  coaching_cues = v.coaching_cues,
  common_mistakes = v.common_mistakes,
  safety_tips = v.safety_tips,
  contraindications = v.contraindications,
  breathing_tips = v.breathing_tips,
  tempo_recommendation = NULL,
  tags = v.tags,
  search_keywords = trim(concat_ws(' ', name, target_muscle, secondary_muscles, equipment,
    exercise_type, movement_pattern, v.tags_text))
FROM (VALUES
  ('Bicycling', 'TIME', ARRAY['TIME','DISTANCE','SPEED','CALORIES','RPM','HEART_RATE','RPE','INTERVAL']::text[],
   'A continuous cycling effort used to build aerobic capacity with controllable resistance and cadence.',
   'Adjust the seat so the knee stays slightly bent at the bottom of the stroke. Start easily, settle into a smooth cadence, then adjust resistance or pace to the planned effort. Finish with an easy spin before dismounting.',
   ARRAY['Keep the upper body relaxed and shoulders away from the ears.','Pedal smoothly through the full circle rather than stamping down.','Use a pace that lets you maintain the planned breathing and effort.'],
   ARRAY['Bouncing in the saddle.','Locking the knees at the bottom of each stroke.','Starting too hard and losing sustainable cadence.'],
   ARRAY['Check the seat and handlebar position before increasing resistance.','Keep hands light on the bars and use the emergency stop or dismount procedure if dizzy.'],
   ARRAY['Stop and seek appropriate assessment for chest pain, faintness, or unusual breathlessness.','Use a lower-impact option when the planned effort cannot be completed comfortably.'],
   'Breathe continuously and avoid breath-holding; use a steady exhale during harder pushes.',
   ARRAY['aerobic','cycling','endurance','cadence','steady-state'], 'bike cycling endurance cadence'),
  ('Bicycling_Stationary', 'TIME', ARRAY['TIME','DISTANCE','SPEED','CALORIES','RPM','HEART_RATE','RPE','INTERVAL']::text[],
   'A stationary-bike session for repeatable aerobic work, cadence practice, and interval training.',
   'Set the saddle and handlebars before starting. Begin with light resistance, establish a comfortable cadence, and follow the selected duration or interval plan. Cool down before stepping off.',
   ARRAY['Keep hips stable and pedal quietly.','Increase one variable at a time: resistance, cadence, or duration.','Use the bike display as a guide, not as a substitute for effort feedback.'],
   ARRAY['Using a seat height that makes the knee fully locked or excessively bent.','Leaning heavily on the handlebars.','Treating estimated calories as an exact measurement.'],
   ARRAY['Confirm the machine is stable and the resistance changes smoothly.','Hold the handles when standing or dismounting.'],
   ARRAY['Stop for chest pain, faintness, or unusual symptoms.','Machine heart-rate and calorie estimates are approximate and should not be treated as clinical measurements.'],
   'Maintain relaxed, rhythmic breathing; increase exhalation length if the effort rises.',
   ARRAY['aerobic','stationary-bike','endurance','intervals'], 'stationary bike aerobic endurance intervals'),
  ('Elliptical_Trainer', 'TIME', ARRAY['TIME','DISTANCE','SPEED','CALORIES','HEART_RATE','RPE','INTERVAL']::text[],
   'A low-impact continuous cardio effort using a smooth linked leg and arm motion.',
   'Step on while holding the fixed handles, select a low resistance, and find a quiet forward stride. Add resistance or incline only after posture and rhythm are consistent. Finish with an easy pace.',
   ARRAY['Stay tall with a light grip.','Drive through the whole foot and keep the stride quiet.','Match arm movement to the leg rhythm instead of pulling with the arms.'],
   ARRAY['Leaning on the handles.','Taking uncontrolled, overly long strides.','Increasing resistance before establishing a stable rhythm.'],
   ARRAY['Use the fixed handles while mounting and dismounting.','Keep feet centered on the pedals and check the machine is fully stopped before stepping off.'],
   ARRAY['Stop for chest pain, faintness, or unusual breathlessness.','Use a comfortable range of motion and lower resistance if joint discomfort appears.'],
   'Breathe continuously with a pace that supports the selected intensity zone.',
   ARRAY['aerobic','elliptical','low-impact','endurance'], 'elliptical low impact aerobic endurance'),
  ('Jogging_Treadmill', 'TIME_SPEED', ARRAY['TIME','DISTANCE','SPEED','PACE','TIME_SPEED','TIME_DISTANCE','CALORIES','HEART_RATE','RPE','INTERVAL']::text[],
   'A treadmill jogging effort for controlled aerobic running at a sustainable speed.',
   'Step onto the stationary belt, attach the safety clip, and begin walking before increasing speed. Set the planned speed and incline gradually. Keep the stride quiet and reduce speed before stopping.',
   ARRAY['Keep eyes forward and posture tall.','Land under the body with a light, quick stride.','Use the rails only for mounting, dismounting, or safety.'],
   ARRAY['Holding the rails while jogging.','Starting at the target speed without a warm-up.','Overstriding in front of the hips.'],
   ARRAY['Use the safety clip and know the emergency-stop procedure.','Increase speed or incline in small steps, especially after a break from running.'],
   ARRAY['Stop for chest pain, faintness, or unusual breathlessness.','Choose a lower-impact alternative when impact cannot be tolerated comfortably.'],
   'Use rhythmic breathing; a conversational pace should allow controlled speech without gasping.',
   ARRAY['treadmill','jogging','aerobic','pace','intervals'], 'treadmill jogging running pace incline'),
  ('Prowler_Sprint', 'DISTANCE_LOAD', ARRAY['DISTANCE','TIME','DISTANCE_LOAD','TIME_LOAD','INTERVAL','ROUNDS']::text[],
   'A loaded sled push performed over short distances to train acceleration and high-effort conditioning.',
   'Load the sled conservatively, choose high or low handles, brace the trunk, and lean into the sled. Drive with short, forceful steps for the planned distance, then stop under control and recover fully.',
   ARRAY['Keep a straight line from hands through hips.','Use short steps and push the ground away.','Treat load and distance as separate progression variables.'],
   ARRAY['Loading so heavily that posture collapses.','Taking long reaching steps.','Turning or stopping abruptly while fatigued.'],
   ARRAY['Clear the lane and confirm the sled surface is suitable.','Use a spotter or controlled stop when the sled is heavy.'],
   ARRAY['Stop for chest pain, faintness, or sharp joint/back pain.','High-effort sled work is not a substitute for medical clearance where screening requires it.'],
   'Brace before the drive, then take short controlled breaths rather than holding the breath for the full sprint.',
   ARRAY['sled','prowler','sprint','conditioning','loaded-carry'], 'prowler sled sprint distance load conditioning'),
  ('Recumbent_Bike', 'TIME', ARRAY['TIME','DISTANCE','SPEED','CALORIES','RPM','HEART_RATE','RPE','INTERVAL']::text[],
   'A supported cycling effort with a reclined seat, useful for steady aerobic work and controlled intervals.',
   'Adjust the seat so the knee remains slightly bent at full extension. Start with light resistance, settle into an even cadence, and follow the planned duration or intervals. Reduce resistance before exiting.',
   ARRAY['Keep the lower back supported by the seat.','Pedal smoothly without locking the knees.','Let effort come from cadence or resistance, not from bracing the shoulders.'],
   ARRAY['Seat too far away or too close.','Pushing only with the toes.','Using the backrest as an excuse to stop moving actively.'],
   ARRAY['Check the seat lock and foot straps before starting.','Use the handles while entering and leaving the machine.'],
   ARRAY['Stop for chest pain, faintness, or unusual breathlessness.','Machine calorie and heart-rate estimates are approximate.'],
   'Keep breathing regular and relaxed throughout the session.',
   ARRAY['recumbent-bike','aerobic','low-impact','endurance'], 'recumbent bike low impact aerobic endurance'),
  ('Rope_Jumping', 'TIME', ARRAY['TIME','REPS','ROUNDS','INTERVAL','RPE']::text[],
   'A rhythmic jump-rope effort that develops conditioning, coordination, and elastic lower-limb endurance.',
   'Choose a rope length that clears the head and feet. Turn the rope with the wrists, keep jumps low, and land softly on the balls of the feet. Use planned work and recovery periods.',
   ARRAY['Keep the jump just high enough for the rope.','Turn from the wrists with relaxed elbows.','Stay tall and land quietly.'],
   ARRAY['Jumping too high.','Spinning from the shoulders.','Continuing after cadence or landing quality breaks down.'],
   ARRAY['Use a clear, even surface and appropriate footwear.','Start with short intervals before progressing total time.'],
   ARRAY['Stop for dizziness, chest pain, or sharp lower-limb pain.','Reduce impact or choose another modality when repeated jumping is unsuitable.'],
   'Use a light, regular breath matched to the rope rhythm; do not hold the breath during intervals.',
   ARRAY['jump-rope','skipping','coordination','intervals','conditioning'], 'jump rope skipping rope intervals cadence'),
  ('Rowing_Stationary', 'TIME_DISTANCE', ARRAY['TIME','DISTANCE','PACE','SPEED','TIME_DISTANCE','CALORIES','HEART_RATE','RPE','INTERVAL','RPM']::text[],
   'A full-body rowing effort where leg drive, hip swing, and arm finish combine into repeatable strokes.',
   'Set the foot straps, begin at the catch with a neutral spine, drive through the legs, then swing the hips and finish with the arms. Recover in reverse order: arms, hips, then knees. Keep the planned stroke rate and distance or time visible.',
   ARRAY['Legs first, then hips, then arms on the drive.','Return the handle before bending the knees.','Keep the spine long and the recovery controlled.'],
   ARRAY['Rounding the back at the catch.','Pulling early with the arms.','Rushing the recovery and losing stroke length.'],
   ARRAY['Secure the foot straps without restricting circulation.','Start with a manageable damper/resistance and stop if technique deteriorates.'],
   ARRAY['Stop for chest pain, faintness, or sharp back pain.','Use a lower stroke rate and shorter duration when rebuilding technique.'],
   'Exhale during the drive and inhale during the recovery, keeping the breathing rhythm repeatable.',
   ARRAY['rowing','ergometer','stroke-rate','pace','endurance'], 'rowing ergometer distance pace stroke rate'),
  ('Running_Treadmill', 'TIME_SPEED', ARRAY['TIME','DISTANCE','SPEED','PACE','TIME_SPEED','TIME_DISTANCE','CALORIES','HEART_RATE','RPE','INTERVAL']::text[],
   'A controlled treadmill running effort for aerobic development, pacing, and interval work.',
   'Attach the safety clip, start walking, and raise speed gradually. Run with a quiet stride, relaxed arms, and eyes forward. Reduce speed to a walk before stopping the belt.',
   ARRAY['Keep the foot landing under the center of mass.','Relax the hands and shoulders.','Use incline or speed deliberately, not both aggressively at once.'],
   ARRAY['Holding the rails while running.','Overstriding.','Stopping the belt while still at running speed.'],
   ARRAY['Use the emergency-stop procedure and safety clip.','Warm up before hard intervals and cool down before stepping off.'],
   ARRAY['Stop for chest pain, faintness, or unusual breathlessness.','Progress impact and speed gradually when returning to running.'],
   'Use steady rhythmic breathing for continuous work and controlled exhalation during faster intervals.',
   ARRAY['treadmill','running','aerobic','pace','intervals'], 'treadmill running speed pace incline distance'),
  ('Skating', 'TIME', ARRAY['TIME','DISTANCE','SPEED','PACE','HEART_RATE','RPE','INTERVAL']::text[],
   'A skating-based conditioning effort requiring balance, lateral force, and repeated propulsion.',
   'Wear appropriate protective equipment, establish balance at an easy pace, and use controlled knee and hip flexion. Build speed only after turning and stopping are reliable.',
   ARRAY['Keep knees softly bent and weight centered over the skates.','Push laterally rather than standing tall between strokes.','Look ahead and leave space for stopping.'],
   ARRAY['Skating faster than stopping ability allows.','Locked knees and upright posture.','Ignoring surface changes or crowded lanes.'],
   ARRAY['Use a helmet and suitable protective gear.','Inspect the surface and equipment before the session.'],
   ARRAY['Stop for dizziness, chest pain, or a fall-related injury.','Use a controlled pace and shorter intervals when balance is limited.'],
   'Breathe continuously and use recovery intervals to regain control of balance and cadence.',
   ARRAY['skating','roller-skating','balance','lateral-conditioning'], 'skating roller skating balance conditioning'),
  ('Stairmaster', 'TIME', ARRAY['TIME','FLOORS','STEPS','SPEED','CALORIES','HEART_RATE','RPE','INTERVAL']::text[],
   'A stair-climbing machine effort for sustained lower-body and cardiovascular conditioning.',
   'Step on carefully, select a manageable level, and climb with an upright torso. Touch the rails lightly for balance rather than unloading body weight. Lower the level before dismounting.',
   ARRAY['Drive through the whole foot.','Keep steps consistent and avoid skipping steps unless specifically planned.','Use the display to manage sustainable effort.'],
   ARRAY['Hanging on the rails.','Taking hurried steps at a level that cannot be controlled.','Dismounting before the machine slows.'],
   ARRAY['Use the handrails when mounting and dismounting.','Keep the lane clear and follow the machine stop procedure.'],
   ARRAY['Stop for chest pain, faintness, or unusual breathlessness.','Lower the level when step quality or balance deteriorates.'],
   'Maintain an even breathing rhythm; recover at a lower level rather than holding the breath.',
   ARRAY['stairmaster','stairs','floors','steps','conditioning'], 'stairmaster stair climbing floors steps level'),
  ('Step_Mill', 'TIME', ARRAY['TIME','FLOORS','STEPS','SPEED','CALORIES','HEART_RATE','RPE','INTERVAL']::text[],
   'A rotating-step climbing effort for challenging aerobic and lower-body conditioning.',
   'Mount while holding the rails, start at a slow level, and establish a repeatable step rhythm. Keep the torso tall and use the rails only for balance. Reduce speed before leaving the machine.',
   ARRAY['Keep steps deliberate and centered.','Maintain a light grip instead of hanging from the rails.','Choose a level that allows safe, repeatable foot placement.'],
   ARRAY['Looking down continuously.','Skipping steps without a clear plan.','Trying to jump off while the steps are moving quickly.'],
   ARRAY['Use the machine handrails and stop controls.','Check that footwear is secure before mounting.'],
   ARRAY['Stop for chest pain, faintness, or unusual breathlessness.','Reduce level or stop when balance becomes unreliable.'],
   'Use steady nasal or mixed breathing at easier levels and controlled exhalation as intensity rises.',
   ARRAY['step-mill','stairs','floors','steps','conditioning'], 'step mill stair climbing floors steps level'),
  ('Trail_Running_Walking', 'TIME_DISTANCE', ARRAY['TIME','DISTANCE','SPEED','PACE','TIME_DISTANCE','CALORIES','HEART_RATE','RPE','INTERVAL']::text[],
   'Outdoor walking or running on variable terrain, combining aerobic work with balance and terrain management.',
   'Choose a marked route and suitable footwear. Start on easier terrain, shorten the stride on descents, and adjust pace for hills and surface changes. Track either total time, distance, or both.',
   ARRAY['Scan the trail several steps ahead.','Shorten stride on descents and uneven ground.','Use effort rather than flat-ground speed to judge intensity.'],
   ARRAY['Running downhill too aggressively.','Ignoring weather, surface, or daylight changes.','Using an unsuitable shoe for the terrain.'],
   ARRAY['Carry water and use a route appropriate to experience and conditions.','Stay aware of traffic, other trail users, and changing footing.'],
   ARRAY['Stop for chest pain, faintness, or a significant fall.','Modify terrain and pace when pain or instability changes movement quality.'],
   'Use conversational breathing on steady sections and controlled recovery breathing after hills.',
   ARRAY['trail','running','walking','hiking','terrain','outdoor'], 'trail running walking hiking terrain pace distance'),
  ('Walking_Treadmill', 'TIME_SPEED', ARRAY['TIME','DISTANCE','SPEED','PACE','TIME_SPEED','TIME_DISTANCE','CALORIES','HEART_RATE','RPE','INTERVAL']::text[],
   'A controlled treadmill walking effort for low-impact aerobic conditioning and pace progression.',
   'Attach the safety clip, begin at a comfortable walk, and increase speed or incline gradually. Keep a natural stride and use the rails only for mounting, dismounting, or safety.',
   ARRAY['Walk tall with relaxed shoulders.','Keep the stride natural and land softly.','Progress speed and incline separately so effort remains controlled.'],
   ARRAY['Holding the rails throughout the session.','Taking steps that are too long for the belt speed.','Increasing incline before adapting to the speed.'],
   ARRAY['Use the safety clip and emergency-stop procedure.','Keep footwear secure and check the belt is clear before starting.'],
   ARRAY['Stop for chest pain, faintness, or unusual breathlessness.','Use a lower speed or incline if symptoms or gait changes appear.'],
   'Use comfortable rhythmic breathing; a moderate pace should allow controlled conversation.',
    ARRAY['treadmill','walking','low-impact','incline','aerobic'], 'treadmill walking speed pace incline distance')
) AS v(source_id, primary_mode, allowed_modes, description, instructions, coaching_cues,
      common_mistakes, safety_tips, contraindications, breathing_tips, tags, tags_text)
WHERE public.exercises.source_id = v.source_id
  AND public.exercises.exercise_type = 'Cardio'
  AND public.exercises.deleted_at IS NULL;

-- The source data has one Walking_Treadmill row. Keep this assertion visible in
-- the migration log if a future import changes that identity.
DO $$
DECLARE updated_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO updated_count
    FROM public.exercises
   WHERE exercise_type = 'Cardio'
     AND deleted_at IS NULL
     AND prescription_mode_primary IS NOT NULL;
  IF updated_count <> 14 THEN
    RAISE EXCEPTION 'Expected 14 enriched cardio exercises, found %', updated_count;
  END IF;
END $$;
