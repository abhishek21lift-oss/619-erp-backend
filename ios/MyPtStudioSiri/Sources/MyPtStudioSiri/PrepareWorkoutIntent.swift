import AppIntents
import Foundation

/// "Hey Siri, create a workout for Rahul."
///
/// ## The first intent that can change something
///
/// Phases 1–4 answered questions. This one writes, and that changes three
/// things about how it is built:
///
/// - **It does not run from the lock screen.** `authenticationPolicy` is
///   `.requiresAuthentication`. A read spoken to a locked phone leaks; a write
///   accepts an instruction from anyone standing near one, and Face ID is the
///   difference between "my trainer asked for this" and "somebody in the gym
///   said it out loud".
/// - **It asks before it saves.** `requestConfirmation` states what was
///   prepared and waits. The user can say no, and saying nothing is also no.
/// - **It cannot describe what to save.** The confirmation sends back one
///   draft id. Every exercise in the plan was chosen, checked against the
///   library, and filtered against the client's medical record by the server —
///   there is no field on the confirm call through which this device could
///   introduce an exercise, including one the safety filter removed.
///
/// ## Two calls, not one
///
/// `/prepare` builds and describes; `/confirm` saves. If the user declines,
/// nothing was ever written: the draft simply expires. That is why the
/// preparation is allowed to be the chatty step and the save is one word.
@available(iOS 16.0, *)
struct PrepareWorkoutIntent: AppIntent {

    static var title: LocalizedStringResource = "Create a Workout"

    static var description = IntentDescription(
        "Prepares a workout for a client and asks before saving it.",
        categoryName: "Clients",
        searchKeywords: ["create", "workout", "plan", "programme", "prepare"]
    )

    static var openAppWhenRun: Bool = false

    /// NOT `.alwaysAllowed`, unlike every other intent in this app. See above:
    /// this one writes.
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    /// Who the workout is for.
    ///
    /// The same `ClientEntity` Phase 3 defines, so "create a workout for
    /// Rahul" resolves through `ClientEntityQuery` and two clients called
    /// Rahul produce a disambiguation prompt — before anything is generated,
    /// and long before anything is saved.
    @Parameter(
        title: "Client",
        requestValueDialog: IntentDialog("Who is the workout for?")
    )
    var client: ClientEntity

    /// How many sessions. Optional — the server's default is four.
    ///
    /// Bounded on the server as well as here: a spoken number is easy to
    /// mishear, and "forty" must not become a forty-session plan.
    @Parameter(title: "Sessions", default: 4, inclusiveRange: (1, 6))
    var days: Int

    static var parameterSummary: some ParameterSummary {
        Summary("Create a \(\.$days)-day workout for \(\.$client)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let api = VoiceAPIClient.fromBundle() else {
            throw VoiceAPIError.notConfigured
        }

        // 1. Prepare. This writes no plan — it returns a draft and the
        //    sentence describing it, including anything the safety filter
        //    withheld and whether the client's screening paperwork is short.
        let draft: WorkoutDraftResponse
        do {
            draft = try await api.prepareWorkout(clientId: client.id, days: days)
        } catch let error as VoiceAPIError {
            // A medically blocked client arrives here, carrying the server's
            // own sentence about clearance rather than a status code this
            // intent would have to guess at.
            throw error
        }

        // Belt and braces. The endpoint is specified never to save, and if
        // that ever stopped being true this intent must not go on to ask a
        // question whose answer no longer matters.
        guard draft.saved == false else {
            return .result(dialog: IntentDialog(stringLiteral: draft.spoken))
        }

        // 2. Ask. `requestConfirmation` throws if the user declines or the
        //    request is cancelled — and throwing here is exactly right, since
        //    the correct outcome of "no" is that nothing further happens. The
        //    draft is left to expire on its own.
        try await requestConfirmation(
            result: .result(dialog: IntentDialog(stringLiteral: draft.spoken)),
            confirmationActionName: .save
        )

        // 3. Save. One id, nothing else.
        let saved = try await api.confirmWorkout(draftId: draft.draftId)
        return .result(dialog: IntentDialog(stringLiteral: saved.spoken))
    }
}
