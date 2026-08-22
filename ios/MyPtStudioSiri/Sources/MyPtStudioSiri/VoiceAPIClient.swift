import Foundation

/// What the voice endpoints return: a number, and the sentence to say.
///
/// `spoken` comes from the server rather than being assembled here, so the
/// phrasing and its pluralisation can be corrected without an App Store
/// release. The client's job is to read it out, not to write it.
struct ClientCountResponse: Decodable {
    let count: Int
    let scope: String
    let spoken: String
}

/// Every way this can fail, phrased as something Siri can say.
///
/// The distinction that matters is `unauthorized` vs `network`: one is fixed
/// by opening the app and signing in, the other by trying again in a moment.
/// Collapsing them into "something went wrong" sends the user to the wrong
/// remedy, which on a voice surface they cannot see or work around.
enum VoiceAPIError: LocalizedError {
    case notConfigured
    case notSignedIn
    case unauthorized
    case rateLimited
    case server(status: Int)
    case network(underlying: Error)
    case malformedResponse

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "MY PT STUDIO is not set up on this device yet."
        case .notSignedIn, .unauthorized:
            return "Please sign in to MY PT STUDIO first."
        case .rateLimited:
            return "Too many requests just now. Please try again in a moment."
        case .server:
            return "MY PT STUDIO could not answer that right now."
        case .network:
            return "I could not reach MY PT STUDIO. Check your connection."
        case .malformedResponse:
            return "MY PT STUDIO sent back something unexpected."
        }
    }
}

/// Talks to the MY PT STUDIO voice API.
///
/// ## No secrets in here
///
/// There is no API key, no client secret and no base URL literal in this file.
/// The base URL comes from the app's Info.plist (build configuration) and the
/// bearer token comes from the Keychain, written by the host app when the user
/// signs in normally. An intent never sees credentials, only a token that the
/// user's own sign-in produced.
///
/// ## The intent never sends a query
///
/// It sends a path and a bearer token. It does not send an organization id —
/// the server derives that from the session — so there is nothing this client
/// could set, by accident or otherwise, that would widen what it can read.
struct VoiceAPIClient {

    /// Keychain account name the host app writes the session token under.
    static let tokenAccount = "com.myptstudio.session.token"

    private let baseURL: URL
    private let accessGroup: String?
    private let session: URLSession

    /// - Parameters:
    ///   - baseURL: the API origin, from `MPS_API_BASE_URL` in Info.plist.
    ///   - accessGroup: the shared keychain group; nil in unit tests.
    init(baseURL: URL, accessGroup: String?, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.accessGroup = accessGroup
        self.session = session
    }

    /// Build from the app's own configuration, or nil when it is missing.
    static func fromBundle(_ bundle: Bundle = .main) -> VoiceAPIClient? {
        guard
            let raw = bundle.object(forInfoDictionaryKey: "MPS_API_BASE_URL") as? String,
            let url = URL(string: raw),
            // https only. A voice token must never be sent in the clear, and a
            // misconfigured http base URL is a silent downgrade rather than a
            // visible failure.
            url.scheme == "https"
        else { return nil }

        let group = bundle.object(forInfoDictionaryKey: "MPS_KEYCHAIN_ACCESS_GROUP") as? String
        return VoiceAPIClient(baseURL: url, accessGroup: group)
    }

    /// GET /api/voice/dashboard/client-count
    func clientCount() async throws -> ClientCountResponse {
        guard let token = Keychain.get(account: Self.tokenAccount, accessGroup: accessGroup) else {
            throw VoiceAPIError.notSignedIn
        }

        var request = URLRequest(url: baseURL.appendingPathComponent("api/voice/dashboard/client-count"))
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // Siri gives an intent a short budget before it is considered stalled;
        // a request that outlives that is better failed than left hanging.
        request.timeoutInterval = 10

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw VoiceAPIError.network(underlying: error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw VoiceAPIError.malformedResponse
        }

        switch http.statusCode {
        case 200:
            break
        case 401:
            // The token expired or was revoked. Nothing is retried and nothing
            // is refreshed here: re-authentication belongs to the host app,
            // where the user can actually see what they are signing into.
            throw VoiceAPIError.unauthorized
        case 403:
            // A staff-only surface reached by a client account. Same remedy as
            // signing in, from the user's point of view.
            throw VoiceAPIError.unauthorized
        case 429:
            throw VoiceAPIError.rateLimited
        default:
            throw VoiceAPIError.server(status: http.statusCode)
        }

        do {
            return try JSONDecoder().decode(ClientCountResponse.self, from: data)
        } catch {
            throw VoiceAPIError.malformedResponse
        }
    }
}
