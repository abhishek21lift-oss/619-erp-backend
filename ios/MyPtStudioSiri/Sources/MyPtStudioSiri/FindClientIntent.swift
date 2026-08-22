import AppIntents
import Foundation

/// "Hey Siri, find Rahul in MY PT STUDIO."
///
/// ## The one difference from Phase 1
///
/// This intent takes a PARAMETER, and it is spoken by a human in a room. That
/// changes two things:
///
/// - The name is passed as a query-string value to a named endpoint. It never
///   becomes SQL here or there — the server binds it as a parameter and builds
///   the query itself, so there is no phrase that can be said aloud which
///   reaches the database as anything but a search term.
/// - The answer NAMES A PERSON out loud. So the intent reads the server's
///   sentence and nothing else: the response carries no phone number, email or
///   address to leak, because those columns are never selected.
///
/// ## Ambiguity is surfaced, not resolved
///
/// Two clients called Rahul is the ordinary case. The server counts them and
/// names them rather than choosing, and this intent says so — stating one
/// person's expiry date with confidence when it might be the other's is the
/// failure worth avoiding here.
@available(iOS 16.0, *)
struct FindClientIntent: AppIntent {

    static var title: LocalizedStringResource = "Find Client"

    static var description = IntentDescription(
        "Finds a client in MY PT STUDIO and says their package status.",
        categoryName: "Clients",
        searchKeywords: ["find", "search", "client", "member", "PT", "package"]
    )

    static var openAppWhenRun: Bool = false

    /// Runs from the lock screen, like the count intent. The Keychain item is
    /// stored `AfterFirstUnlock` so the token is readable there.
    static var authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

    /// The name to look for.
    ///
    /// `requestValueDialog` is what Siri asks when the phrase did not include
    /// one — "find someone in MY PT STUDIO" should prompt for a name rather
    /// than fail.
    @Parameter(
        title: "Name",
        requestValueDialog: IntentDialog("Who are you looking for?")
    )
    var name: String

    static var parameterSummary: some ParameterSummary {
        Summary("Find \(\.$name) in MY PT STUDIO")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let client = VoiceAPIClient.fromBundle() else {
            throw VoiceAPIError.notConfigured
        }

        do {
            let result = try await client.searchClients(matching: name)
            // The server's sentence, spoken verbatim — it already phrases all
            // five cases (none, one active, one expired, one inactive, several)
            // and keeping the wording server-side means it can be corrected
            // without an App Store release.
            return .result(dialog: IntentDialog(stringLiteral: result.spoken))
        } catch let error as VoiceAPIError {
            // Each case carries a sentence naming the remedy: sign in, say more
            // of the name, check your connection, try again shortly.
            throw error
        }
    }
}
