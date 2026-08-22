import AppIntents
import Foundation

/// "Hey Siri, mark Rahul's workout as completed."
///
/// ## Why this one has no confirmation step
///
/// Phase 5's `PrepareWorkoutIntent` asks before saving, because it CREATES a
/// training programme and the thing being agreed to — four days of exercises,
/// minus whatever the safety filter withheld — cannot be held in one spoken
/// sentence. This intent flips one status on a session that already exists.
/// The whole effect fits in the sentence Siri says back, so a confirmation
/// step would be a second question about something the user already described
/// completely in the first.
///
/// ## What it does have instead: idempotence
///
/// Siri repeats itself when it mishears, and a phrase can fire twice. The
/// server completes at most once and reports which happened, so the second
/// request is answered "that was already marked completed" rather than
/// silently writing again. The distinction is spoken, not swallowed: "done"
/// when nothing changed teaches a trainer that the command works when it may
/// not have.
///
/// ## Still authenticated, still not from the lock screen
///
/// It writes. Same policy as Phase 5: a read spoken to a locked phone leaks,
/// but a write accepts an instruction from anyone standing near one.
@available(iOS 16.0, *)
struct CompleteWorkoutIntent: AppIntent {

    static var title: LocalizedStringResource = "Mark Workout Completed"

    static var description = IntentDescription(
        "Marks a client's workout for today as completed.",
        categoryName: "Clients",
        searchKeywords: ["complete", "completed", "done", "finished", "workout", "session"]
    )

    static var openAppWhenRun: Bool = false

    /// Writes, so it does not run from a locked device.
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    /// Whose workout.
    ///
    /// The `ClientEntity` from Phase 3, so two clients called Rahul are
    /// disambiguated before anything is written — the one case where guessing
    /// would mark the wrong person's session done, and neither of them would
    /// find out until the record was already wrong.
    @Parameter(
        title: "Client",
        requestValueDialog: IntentDialog("Whose workout should I mark completed?")
    )
    var client: ClientEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Mark \(\.$client)'s workout completed")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let api = VoiceAPIClient.fromBundle() else {
            throw VoiceAPIError.notConfigured
        }

        do {
            // No date is sent. "Today" belongs to the studio, and resolving it
            // here would let a handset in another timezone — or one with a
            // wrong clock — complete the wrong day's session.
            let result = try await api.completeWorkout(clientId: client.id)

            // The server's sentence, verbatim, and it already distinguishes
            // the three outcomes: marked now, already marked, and nothing
            // found to mark.
            return .result(dialog: IntentDialog(stringLiteral: result.spoken))
        } catch let error as VoiceAPIError {
            // A client with no session logged arrives here as `.refused`,
            // carrying the server's own sentence — "I could not find a workout
            // for Rahul on that day" — rather than a status code this intent
            // would have to turn back into an explanation.
            throw error
        }
    }
}
