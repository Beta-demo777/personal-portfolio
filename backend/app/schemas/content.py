from datetime import date as calendar_date
from datetime import datetime, timezone
from typing import Annotated, Literal, Optional, Union
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


ShortText = Annotated[str, Field(max_length=512)]
MediumText = Annotated[str, Field(max_length=5_000)]
LongText = Annotated[str, Field(max_length=200_000)]
Identifier = Annotated[str, Field(min_length=1, max_length=128)]
Slug = Annotated[str, Field(min_length=1, max_length=200)]
NonNegativeCount = Annotated[int, Field(ge=0, le=2_147_483_647)]


class StrictContentModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


def _validate_web_url(value: str, *, allow_relative: bool = False, allow_hash: bool = False) -> str:
    if not value:
        return value
    if allow_hash and value == "#":
        return value
    if any(character.isspace() or ord(character) < 32 for character in value) or "\\" in value:
        raise ValueError("URL must not contain whitespace, control characters, or backslashes")
    if allow_relative and value.startswith("/") and not value.startswith("//"):
        return value

    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("URL must be an absolute HTTP(S) URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("URL credentials are not allowed")
    try:
        parsed.port
    except ValueError as error:
        raise ValueError("URL port is invalid") from error
    return value


def parse_scheduled_at(value: str) -> datetime:
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        scheduled_at = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise ValueError("Blog post scheduledAt must be a valid ISO-8601 timestamp") from error
    if scheduled_at.tzinfo is None or scheduled_at.utcoffset() is None:
        raise ValueError("Blog post scheduledAt must include a timezone")
    try:
        return scheduled_at.astimezone(timezone.utc)
    except OverflowError as error:
        raise ValueError("Blog post scheduledAt must be a valid ISO-8601 timestamp") from error


def validate_route_key(value: str, *, label: str) -> str:
    if value != value.strip():
        raise ValueError(f"{label} must not have leading or trailing whitespace")
    if not any(character.isalnum() for character in value) or any(
        not (character.isalnum() or character in "-_") for character in value
    ):
        raise ValueError(
            f"{label} may contain only Unicode letters, numbers, hyphens, and underscores"
        )
    return value


def normalize_route_key(value: str) -> str:
    return value.strip().lower()


class ExperienceItem(StrictContentModel):
    year: ShortText
    role: ShortText
    desc: MediumText


class PersonalInfo(StrictContentModel):
    name: ShortText
    title: ShortText
    bio: MediumText
    location: ShortText
    email: ShortText
    github: ShortText
    twitter: ShortText
    experience: Annotated[list[ExperienceItem], Field(max_length=100)]

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        if value and (
            len(value) > 254
            or value.count("@") != 1
            or any(character.isspace() for character in value)
        ):
            raise ValueError("email must be empty or a valid email address")
        return value

    @field_validator("github", "twitter")
    @classmethod
    def validate_profile_url(cls, value: str) -> str:
        return _validate_web_url(value)


class TechStackGroup(StrictContentModel):
    id: Identifier
    title: ShortText
    items: Annotated[list[ShortText], Field(max_length=100)]


class ProjectStats(StrictContentModel):
    stars: Optional[NonNegativeCount] = None
    forks: Optional[NonNegativeCount] = None
    impact: Optional[ShortText] = None


class Project(StrictContentModel):
    id: Identifier
    title: ShortText
    description: MediumText
    longDescription: Optional[MediumText] = None
    tags: Annotated[list[ShortText], Field(max_length=50)]
    url: Optional[ShortText] = None
    github: Optional[ShortText] = None
    stats: ProjectStats
    featured: bool
    role: ShortText
    year: ShortText

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        return validate_route_key(value, label="Project id")

    @field_validator("url", "github")
    @classmethod
    def validate_project_url(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        return _validate_web_url(value, allow_hash=True)


class BlogPost(StrictContentModel):
    id: Identifier
    title: ShortText
    slug: Optional[Slug] = None
    excerpt: MediumText
    content: LongText
    date: ShortText
    readTime: ShortText
    category: ShortText
    tags: Annotated[list[ShortText], Field(max_length=50)]
    views: NonNegativeCount
    likes: NonNegativeCount
    status: Literal["draft", "published"]
    coverImage: Optional[ShortText] = None
    seoTitle: Optional[ShortText] = None
    seoDescription: Optional[MediumText] = None
    scheduledAt: Optional[ShortText] = None

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        return validate_route_key(value, label="Blog post id")

    @field_validator("slug")
    @classmethod
    def validate_slug(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        return validate_route_key(value, label="Blog post slug")

    @field_validator("date")
    @classmethod
    def validate_date(cls, value: str) -> str:
        if len(value) != 10 or value[4] != "-" or value[7] != "-":
            raise ValueError("Blog post date must use the YYYY-MM-DD ISO-8601 full-date format")
        try:
            parsed = calendar_date.fromisoformat(value)
        except ValueError as error:
            raise ValueError(
                "Blog post date must be a valid calendar date in YYYY-MM-DD format"
            ) from error
        if parsed.isoformat() != value:
            raise ValueError("Blog post date must use the YYYY-MM-DD ISO-8601 full-date format")
        return value

    @field_validator("coverImage")
    @classmethod
    def validate_cover_image(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        return _validate_web_url(value, allow_relative=True)

    @field_validator("scheduledAt")
    @classmethod
    def validate_schedule(cls, value: Optional[str]) -> Optional[str]:
        if value and value.strip():
            parse_scheduled_at(value)
        return value


PageId = Literal["home", "showcase", "blog", "agent", "about"]


class NavigationItem(StrictContentModel):
    id: PageId
    label: ShortText


class HighlightCard(StrictContentModel):
    id: Identifier
    title: ShortText
    description: MediumText
    icon: Literal["code", "layers", "sparkles"]


class HomePageContent(StrictContentModel):
    greetings: Annotated[list[ShortText], Field(max_length=30)]
    heroPrefix: ShortText
    heroHighlight: ShortText
    heroSuffix: ShortText
    introduction: MediumText
    highlights: Annotated[list[HighlightCard], Field(max_length=30)]
    portfolioButton: ShortText
    agentButton: ShortText
    blogButton: ShortText


class ShowcasePageContent(StrictContentModel):
    identityLabel: ShortText
    terminalWelcome: MediumText
    terminalHint: MediumText
    terminalTitle: ShortText
    terminalPlaceholder: ShortText
    technologyTitle: ShortText
    worksEyebrow: ShortText
    worksTitle: ShortText
    terminalPrompt: ShortText
    quickLabel: ShortText
    allFilterLabel: ShortText
    terminalHelp: Annotated[list[ShortText], Field(max_length=100)]
    commandNotFound: MediumText
    detailsLabel: ShortText
    repositoryLabel: ShortText
    livePreviewLabel: ShortText
    impactLabel: ShortText
    starsLabel: ShortText
    forksLabel: ShortText


class BlogPageContent(StrictContentModel):
    eyebrow: ShortText
    title: ShortText
    description: MediumText
    searchPlaceholder: ShortText
    noResultsText: MediumText
    backLabel: ShortText
    relatedTitle: ShortText
    allCategoryLabel: ShortText
    readsLabel: ShortText
    likeLabel: ShortText
    linkCopiedLabel: ShortText


class HobbyItem(StrictContentModel):
    id: Identifier
    title: ShortText
    description: MediumText
    icon: Literal["coffee", "code", "game", "screen"]


class AboutPageContent(StrictContentModel):
    eyebrow: ShortText
    title: ShortText
    description: MediumText
    introductionTitle: ShortText
    introduction: Annotated[list[MediumText], Field(max_length=30)]
    experienceTitle: ShortText
    hobbiesTitle: ShortText
    hobbies: Annotated[list[HobbyItem], Field(max_length=30)]
    technologyTitle: ShortText
    contactEyebrow: ShortText
    contactTitle: ShortText
    contactDescription: MediumText
    contactNamePlaceholder: ShortText
    contactMessagePlaceholder: ShortText
    contactSendingLabel: ShortText
    contactSuccessLabel: ShortText
    contactSubmitLabel: ShortText


class AgentPrompt(StrictContentModel):
    label: ShortText
    text: MediumText


class AgentPageContent(StrictContentModel):
    title: ShortText
    description: MediumText
    welcomeMessage: MediumText
    initialBubble: MediumText
    loadingBubble: MediumText
    answeredBubble: MediumText
    resetBubble: MediumText
    inputPlaceholder: ShortText
    displayName: ShortText
    badgeLabel: ShortText
    modelLabel: ShortText
    idleStatus: ShortText
    loadingStatus: ShortText
    interactionHint: MediumText
    suggestionsTitle: ShortText
    resetLabel: ShortText
    samplePrompts: Annotated[list[AgentPrompt], Field(max_length=30)]
    funQuotes: Annotated[list[MediumText], Field(max_length=100)]


class Soundscape(StrictContentModel):
    id: Identifier
    name: ShortText
    description: MediumText
    type: Literal["synth", "noise"]
    frequency: Annotated[Union[int, float], Field(ge=20, le=20_000)]


class MusicPlayerContent(StrictContentModel):
    title: ShortText
    minimizedLabel: ShortText
    standbyLabel: ShortText
    playingPrefix: ShortText
    tracks: Annotated[list[Soundscape], Field(max_length=30)]


class SiteSettings(StrictContentModel):
    siteTitle: ShortText
    siteDescription: MediumText
    brandInitials: ShortText
    navigation: Annotated[list[NavigationItem], Field(max_length=10)]
    footerCopyright: ShortText
    footerBadges: Annotated[list[ShortText], Field(max_length=30)]
    icpNumber: ShortText
    icpUrl: ShortText

    @field_validator("icpUrl")
    @classmethod
    def validate_icp_url(cls, value: str) -> str:
        return _validate_web_url(value)


class ContentPayload(StrictContentModel):
    personalInfo: PersonalInfo
    techStackGroups: Annotated[list[TechStackGroup], Field(max_length=50)]
    projects: Annotated[list[Project], Field(max_length=200)]
    blogPosts: Annotated[list[BlogPost], Field(max_length=500)]
    siteSettings: SiteSettings
    homePage: HomePageContent
    showcasePage: ShowcasePageContent
    blogPage: BlogPageContent
    aboutPage: AboutPageContent
    agentPage: AgentPageContent
    musicPlayer: MusicPlayerContent

    @model_validator(mode="after")
    def validate_unique_content_ids_and_slugs(self):
        for label, items in (("blog post", self.blogPosts), ("project", self.projects)):
            identifiers = [normalize_route_key(item.id) for item in items]
            if len(set(identifiers)) != len(identifiers):
                raise ValueError(f"{label.title()} ids must be unique after case normalization")

        route_key_owners: dict[str, int] = {}
        for index, post in enumerate(self.blogPosts):
            aliases = [post.id]
            if post.slug is not None:
                aliases.append(post.slug)
            for alias in aliases:
                route_key = normalize_route_key(alias)
                owner = route_key_owners.setdefault(route_key, index)
                if owner != index:
                    raise ValueError(
                        "Blog post ids and slugs must be globally unique route keys "
                        "after trimming and case normalization"
                    )
        return self


class UninitializedAdminContentResponse(StrictContentModel):
    initialized: Literal[False]
    content: None


class InitializedAdminContentResponse(StrictContentModel):
    initialized: Literal[True]
    content: ContentPayload


AdminContentResponse = Annotated[
    Union[UninitializedAdminContentResponse, InitializedAdminContentResponse],
    Field(discriminator="initialized"),
]
