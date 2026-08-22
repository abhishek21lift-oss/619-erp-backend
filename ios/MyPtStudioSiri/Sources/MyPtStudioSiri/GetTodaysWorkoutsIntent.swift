import AppIntents
import Foundation

/// "Hey Siri, show me today's workouts in MY PT STUDIO."
///
/// ## Back to no parameters, and that is the point
///
/// Phases 2 and 3 both take input: a name to search, a client to describe.
/// This one takes nothing at all. The subject is always "the signed-in user's
/// own studio, today", derived entirely server-side — so there is no phrase
/// anyone can say, in earshot or otherwise, that widens what comes back.
///
/// ## Today is the STUDIO's today
///
/// The intent does not send a date, a timezone, or the device's clock. It asks
/// for "today" and the server answers in the studio's own zone. That matters
/// more here than anywhere else on this surface: this is the command people
/// use first thing in the morning, and in India a UTC "today" is still
/// yesterday until 05:30 — the exact window a trainer is checking their day.
///
/// ## The answer is a summary, not a roster
///
/// The server names at most three people, by first name, and counts the rest.
/// A spoken list cannot be skimmed: six full names read aloud is not six facts
/// received, it is one long noise ending in a number the listener has already
/// lost track of. The full list is in the response for a Shortcut to use on
/// screen; what Siri SAYS stays short on purpose.
@available(iOS 16.0, *)
struct GetTodaysWorkoutsIntent: AppIntent {

    static var title: LocalizedStringResource = "Get Today's Workouts"

    static var description = IntentDescription(
        "Says how many PT sessions you have today and who the first few are.",
        categoryName: "Dashboard",
        searchKeywords: ["today", "workouts", "sessions", "schedule", "roster", "PT"]
    )

    static var openAppWhenRun: Bool = false

    /// Runs from the lock screen, like the rest of this surface. The Keychain
    /// item is stored `AfterFirstUnlock`, so the token is readable there —
    /// which is where "Hey Siri" is actually used.
    static var authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let api = VoiceAPIClient.fromBundle() else {
            throw VoiceAPIError.notConfigured
        }

        do {
            let today = try await api.todaysWorkouts()
            // The server's sentence, verbatim. It already phrases every case
            // this intent would otherwise have to branch on: an empty day, a
            // single session, several with times, a client whose slot has no
            // time to state, and an account not yet linked to a trainer
            // profile. Keeping the wording server-side means all of it can be
            // corrected without an App Store release.
            //
            // An empty day is a real answer — "You have no workouts scheduled
            // today." — and is deliberately NOT thrown as an error. A trainer
            // with a clear day asked a question and got one.
            return .result(dialog: IntentDialog(stringLiteral: today.spoken))
        } catch let error as VoiceAPIError {
            // Each case carries a sentence naming its own remedy: sign in,
            // check your connection, try again shortly. Rethrowing the raw
            // error would have Siri say something generic and send the user to
            // the wrong fix — on a surface where they cannot see what happened.
            throw error
        }
    }
}
