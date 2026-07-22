import copy
import unittest

from pydantic import ValidationError

from app.schemas.content import ContentPayload


def valid_content() -> dict:
    return {
        "personalInfo": {
            "name": "Beta",
            "title": "Developer",
            "bio": "Bio",
            "location": "Shanghai",
            "email": "",
            "github": "https://github.com/example",
            "twitter": "",
            "experience": [{"year": "2026", "role": "Engineer", "desc": "Built things"}],
        },
        "techStackGroups": [{"id": "backend", "title": "Backend", "items": ["Python"]}],
        "projects": [{
            "id": "portfolio",
            "title": "Portfolio",
            "description": "A portfolio",
            "tags": ["FastAPI"],
            "url": "#",
            "github": "https://github.com/example/portfolio",
            "stats": {"stars": 1, "impact": "Personal site"},
            "featured": True,
            "role": "Author",
            "year": "2026",
        }],
        "blogPosts": [{
            "id": "post-1",
            "title": "Post",
            "slug": "post",
            "excerpt": "Excerpt",
            "content": "# Post",
            "date": "2026-07-16",
            "readTime": "1 min read",
            "category": "Engineering",
            "tags": ["Python"],
            "views": 0,
            "likes": 0,
            "status": "draft",
            "coverImage": "/backend/uploads/0123456789abcdef0123456789abcdef.png",
            "scheduledAt": "2026-07-16T12:00:00+08:00",
        }],
        "siteSettings": {
            "siteTitle": "Portfolio",
            "siteDescription": "Description",
            "brandInitials": "BD",
            "navigation": [{"id": "home", "label": "Home"}],
            "footerCopyright": "Copyright",
            "footerBadges": ["Secure"],
            "icpNumber": "",
            "icpUrl": "https://beian.miit.gov.cn/",
        },
        "homePage": {
            "greetings": ["Hello"],
            "heroPrefix": "Build",
            "heroHighlight": "things",
            "heroSuffix": "well",
            "introduction": "Introduction",
            "highlights": [{
                "id": "code",
                "title": "Code",
                "description": "Description",
                "icon": "code",
            }],
            "portfolioButton": "Portfolio",
            "agentButton": "Agent",
            "blogButton": "Blog",
        },
        "showcasePage": {
            "identityLabel": "Identity",
            "terminalWelcome": "Welcome",
            "terminalHint": "Hint",
            "terminalTitle": "Terminal",
            "terminalPlaceholder": "Command",
            "technologyTitle": "Technology",
            "worksEyebrow": "Works",
            "worksTitle": "Projects",
            "terminalPrompt": "$",
            "quickLabel": "Quick",
            "allFilterLabel": "All",
            "terminalHelp": ["help"],
            "commandNotFound": "Not found",
            "detailsLabel": "Details",
            "repositoryLabel": "Repository",
            "livePreviewLabel": "Preview",
            "impactLabel": "Impact",
            "starsLabel": "Stars",
            "forksLabel": "Forks",
        },
        "blogPage": {
            "eyebrow": "Journal",
            "title": "Blog",
            "description": "Description",
            "searchPlaceholder": "Search",
            "noResultsText": "No results",
            "backLabel": "Back",
            "relatedTitle": "Related",
            "allCategoryLabel": "All",
            "readsLabel": "Reads",
            "likeLabel": "Like",
            "linkCopiedLabel": "Copied",
        },
        "aboutPage": {
            "eyebrow": "About",
            "title": "About me",
            "description": "Description",
            "introductionTitle": "Introduction",
            "introduction": ["Hello"],
            "experienceTitle": "Experience",
            "hobbiesTitle": "Hobbies",
            "hobbies": [{
                "id": "coffee",
                "title": "Coffee",
                "description": "Coffee",
                "icon": "coffee",
            }],
            "technologyTitle": "Technology",
            "contactEyebrow": "Contact",
            "contactTitle": "Contact me",
            "contactDescription": "Description",
            "contactNamePlaceholder": "Name",
            "contactMessagePlaceholder": "Message",
            "contactSendingLabel": "Sending",
            "contactSuccessLabel": "Opened",
            "contactSubmitLabel": "Submit",
        },
        "agentPage": {
            "title": "Agent",
            "description": "Description",
            "welcomeMessage": "Welcome",
            "initialBubble": "Hello",
            "loadingBubble": "Loading",
            "answeredBubble": "Answered",
            "resetBubble": "Reset",
            "inputPlaceholder": "Question",
            "displayName": "Agent",
            "badgeLabel": "Live",
            "modelLabel": "Model",
            "idleStatus": "Idle",
            "loadingStatus": "Loading",
            "interactionHint": "Hint",
            "suggestionsTitle": "Suggestions",
            "resetLabel": "Reset",
            "samplePrompts": [{"label": "About", "text": "Who are you?"}],
            "funQuotes": ["Hello"],
        },
        "musicPlayer": {
            "title": "Music",
            "minimizedLabel": "Music",
            "standbyLabel": "Standby",
            "playingPrefix": "Playing",
            "tracks": [{
                "id": "focus",
                "name": "Focus",
                "description": "Focus track",
                "type": "synth",
                "frequency": 110,
            }],
        },
    }


class ContentPayloadTests(unittest.TestCase):
    def test_valid_complete_camel_case_payload_is_preserved(self) -> None:
        payload = valid_content()
        parsed = ContentPayload.model_validate(payload)
        self.assertEqual(parsed.model_dump(exclude_none=True), payload)

    def test_nested_unknown_field_is_rejected(self) -> None:
        payload = valid_content()
        payload["projects"][0]["stats"]["internalOnly"] = True
        with self.assertRaises(ValidationError):
            ContentPayload.model_validate(payload)

    def test_wrong_scalar_type_is_not_coerced(self) -> None:
        payload = valid_content()
        payload["blogPosts"][0]["views"] = "10"
        with self.assertRaises(ValidationError):
            ContentPayload.model_validate(payload)

    def test_blog_post_status_is_required(self) -> None:
        payload = valid_content()
        del payload["blogPosts"][0]["status"]
        with self.assertRaises(ValidationError):
            ContentPayload.model_validate(payload)

        payload["blogPosts"][0]["status"] = None
        with self.assertRaises(ValidationError):
            ContentPayload.model_validate(payload)

    def test_duplicate_ids_and_case_insensitive_slugs_are_rejected(self) -> None:
        duplicate_id = valid_content()
        duplicate_id["projects"].append(copy.deepcopy(duplicate_id["projects"][0]))
        with self.assertRaises(ValidationError):
            ContentPayload.model_validate(duplicate_id)

        duplicate_slug = valid_content()
        second_post = copy.deepcopy(duplicate_slug["blogPosts"][0])
        second_post.update({"id": "post-2", "slug": "POST"})
        duplicate_slug["blogPosts"].append(second_post)
        with self.assertRaises(ValidationError):
            ContentPayload.model_validate(duplicate_slug)

    def test_blog_post_ids_and_slugs_share_one_route_key_namespace(self) -> None:
        payload = valid_content()
        second_post = copy.deepcopy(payload["blogPosts"][0])
        second_post.update({"id": "post-2", "slug": "POST-1"})
        payload["blogPosts"].append(second_post)
        with self.assertRaises(ValidationError):
            ContentPayload.model_validate(payload)

        same_post_alias = valid_content()
        same_post_alias["blogPosts"][0]["slug"] = "POST-1"
        ContentPayload.model_validate(same_post_alias)

    def test_public_route_keys_reject_unsafe_characters_and_case_duplicate_ids(self) -> None:
        for collection, value in (
            ("blogPosts", " post-1"),
            ("blogPosts", "post/1"),
            ("projects", "portfolio.preview"),
        ):
            with self.subTest(collection=collection, value=value):
                payload = valid_content()
                payload[collection][0]["id"] = value
                with self.assertRaises(ValidationError):
                    ContentPayload.model_validate(payload)

        invalid_slug = valid_content()
        invalid_slug["blogPosts"][0]["slug"] = "article?preview=true"
        with self.assertRaises(ValidationError):
            ContentPayload.model_validate(invalid_slug)

        duplicate_project_id = valid_content()
        second_project = copy.deepcopy(duplicate_project_id["projects"][0])
        second_project["id"] = "PORTFOLIO"
        duplicate_project_id["projects"].append(second_project)
        with self.assertRaises(ValidationError):
            ContentPayload.model_validate(duplicate_project_id)

        unicode_keys = valid_content()
        unicode_keys["projects"][0]["id"] = "作品_2026"
        unicode_keys["blogPosts"][0].update({"id": "文章_1", "slug": "工程-实践"})
        ContentPayload.model_validate(unicode_keys)

    def test_schedule_requires_timezone_and_unsafe_url_is_rejected(self) -> None:
        invalid_schedule = valid_content()
        invalid_schedule["blogPosts"][0]["scheduledAt"] = "2026-07-16T12:00:00"
        with self.assertRaises(ValidationError):
            ContentPayload.model_validate(invalid_schedule)

        unsafe_url = valid_content()
        unsafe_url["projects"][0]["github"] = "javascript:alert(1)"
        with self.assertRaises(ValidationError):
            ContentPayload.model_validate(unsafe_url)

    def test_blog_post_date_requires_a_valid_iso_full_date(self) -> None:
        for valid_date in ("0001-01-01", "2024-02-29", "9999-12-31"):
            with self.subTest(valid_date=valid_date):
                payload = valid_content()
                payload["blogPosts"][0]["date"] = valid_date
                self.assertEqual(
                    ContentPayload.model_validate(payload).blogPosts[0].date,
                    valid_date,
                )

        for invalid_date in (
            "0000-01-01",
            "2023-02-29",
            "2026-02-30",
            "2026-7-17",
            "2026-07-17T00:00:00Z",
            " 2026-07-17",
        ):
            with self.subTest(invalid_date=invalid_date):
                payload = valid_content()
                payload["blogPosts"][0]["date"] = invalid_date
                with self.assertRaises(ValidationError):
                    ContentPayload.model_validate(payload)


if __name__ == "__main__":
    unittest.main()
