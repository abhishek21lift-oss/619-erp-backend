import AppIntents
import Foundation

/// "Hey Siri, does Rahul have any pending payment?"
///
/// A read, so it behaves like Phases 1–4: no confirmation, and it runs from
/// the lock screen because that is where the question gets asked — at the desk,
/// with the client standing there.
///
/// What it does NOT do is recite a ledger. The server returns the outstanding
/// figure and the single most recent payment, and that is all it selects: no
/// receipt numbers, no methods, no history. A balance overheard is bad; a
/// client's payment history narrated to whoever is in the room cannot be
/// un-said.
@available(iOS 16.0, *)
struct CheckPaymentStatusIntent: AppIntent {

    static var title: LocalizedStringResource = "Check Payment Status"

    static var description = IntentDescription(
        "Says what a client owes and when they last paid.",
        categoryName: "Payments",
        searchKeywords: ["payment", "pending", "due", "balance", "outstanding", "owes"]
    )

    static var openAppWhenRun: Bool = false

    /// A read, so the lock screen is fine — the Keychain item is stored
    /// `AfterFirstUnlock`.
    static var authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

    @Parameter(
        title: "Client",
        requestValueDialog: IntentDialog("Whose payment status would you like?")
    )
    var client: ClientEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Check \(\.$client)'s payment status")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let api = VoiceAPIClient.fromBundle() else {
            throw VoiceAPIError.notConfigured
        }

        do {
            let status = try await api.paymentStatus(clientId: client.id)
            // The server's sentence, verbatim. It already distinguishes the
            // three cases that matter and must not be collapsed: something
            // owed, nothing owed, and NO FIGURE ON FILE — which is not the
            // same as nothing owed and must never be spoken as if it were.
            return .result(dialog: IntentDialog(stringLiteral: status.spoken))
        } catch let error as VoiceAPIError {
            throw error
        }
    }
}

/// "Hey Siri, record 3,000 rupees payment from Rahul."
///
/// ## Money, so: two calls and a confirmation
///
/// Same shape as Phase 5's workout creation, and for a sharper reason. The
/// intent asks the server to PREPARE a payment, Siri reads the question back —
/// "Record 3,000 rupees payment for Rahul?" — and only a yes triggers the
/// second call that records it.
///
/// ## The amount does not travel back
///
/// `confirmPayment` takes a draft id and nothing else. If it carried an
/// amount, the figure Siri said out loud and the figure written to the ledger
/// would be two independent values with nothing tying them together, and the
/// confirmation would be a formality rather than a control. Whatever the user
/// agreed to is what the server stored, and what the server stored is what it
/// records.
///
/// ## Not from the lock screen
///
/// It writes, and what it writes is money.
@available(iOS 16.0, *)
struct RecordPaymentIntent: AppIntent {

    static var title: LocalizedStringResource = "Record a Payment"

    static var description = IntentDescription(
        "Records a payment from a client, after confirming the amount.",
        categoryName: "Payments",
        searchKeywords: ["record", "payment", "paid", "collect", "cash"]
    )

    static var openAppWhenRun: Bool = false

    /// Writes money. Face ID is the difference between "my manager asked for
    /// this" and "somebody in the gym said a number out loud".
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(
        title: "Client",
        requestValueDialog: IntentDialog("Who is the payment from?")
    )
    var client: ClientEntity

    /// The amount.
    ///
    /// Bounded here and again on the server. A spoken number is easy to
    /// mishear — "thirty thousand" and "three thousand" are one vowel apart —
    /// and the person confirming is listening rather than reading, which is
    /// exactly why the server reads the figure back before anything is written.
    @Parameter(title: "Amount", requestValueDialog: IntentDialog("How much?"),
               inclusiveRange: (1, 1_000_000))
    var amount: Double

    static var parameterSummary: some ParameterSummary {
        Summary("Record \(\.$amount) from \(\.$client)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let api = VoiceAPIClient.fromBundle() else {
            throw VoiceAPIError.notConfigured
        }

        // 1. Prepare. Records nothing; returns the question, which already
        //    includes a warning if an identical amount went through for this
        //    client minutes ago.
        let draft = try await api.preparePayment(
            clientId: client.id, amount: amount, method: nil
        )

        // Belt and braces: /prepare is specified never to record, and if that
        // ever stopped being true this intent must not go on to ask a question
        // whose answer no longer matters.
        guard draft.recorded == false else {
            return .result(dialog: IntentDialog(stringLiteral: draft.spoken))
        }

        // 2. Ask. Throwing on a decline is right — the correct outcome of "no"
        //    is that nothing happens and the draft is left to expire.
        try await requestConfirmation(
            result: .result(dialog: IntentDialog(stringLiteral: draft.spoken)),
            confirmationActionName: .go
        )

        // 3. Record. One id.
        let recorded = try await api.confirmPayment(draftId: draft.draftId)
        return .result(dialog: IntentDialog(stringLiteral: recorded.spoken))
    }
}
