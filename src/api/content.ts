import { createClient } from '@supabase/supabase-js';
import sharedQuestionBanks from '../config/shared-question-banks.json';

type ContentRequest = {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
};

type ContentResponse = {
  setHeader(name: string, value: string | number | readonly string[]): ContentResponse;
  status(statusCode: number): ContentResponse;
  json(payload: unknown): ContentResponse;
  end(payload?: unknown): ContentResponse;
};

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://pxjvltgarzvoptdfdkxq.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  'sb_publishable_RVLZ7IetJ-w7raWeYGWa5A_5wV4g5rI';

const allowedOrigins = new Set([
  'https://medmacs.app',
  'https://www.medmacs.app',
  'https://medistics.app',
  'https://www.medistics.app',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://localhost:8081',
  'http://localhost:5173',
  'capacitor://localhost',
  'https://com.hmacs.medmacs',
]);

type SubjectLike = {
  institutes?: string[] | null;
};

type SubjectRow = SubjectLike & {
  id: string;
  name: string;
  year: string;
};

type InstituteScope = {
  category?: string | null;
  years?: string[] | null;
};

type ChapterRow = {
  id: string;
  name: string;
  description?: string | null;
  chapter_number: number;
  subject_id: string;
  content_type?: string | null;
  mcqs?: Array<{ count: number }>;
};

type SharedQuestionBankGroup = {
  id: string;
  enabled: boolean;
  sourceSubject: { name: string; instituteCode: string };
  targets: {
    mode: 'all_subjects_for_institute' | 'specialty_for_institute';
    instituteCode: string;
    specialty?: string;
  };
  includeInSubjectPractice: boolean;
  contentType?: 'question_bank' | 'past_paper';
  chapters: Array<{ name: string; sortOrder: number }>;
};

let cachedSharedQuestionBankGroups: SharedQuestionBankGroup[] | null = null;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const getSharedQuestionBankGroups = (): SharedQuestionBankGroup[] => {
  if (cachedSharedQuestionBankGroups) return cachedSharedQuestionBankGroups;

  try {
    const config = sharedQuestionBanks as { version?: unknown; groups?: unknown };
    if (config.version !== 1 || !Array.isArray(config.groups)) throw new Error('Unsupported mapping format');

    const groupIds = new Set<string>();
    const groups: SharedQuestionBankGroup[] = [];
    for (const candidate of config.groups as Array<Record<string, any>>) {
      const source = candidate.sourceSubject as Record<string, unknown> | undefined;
      const targets = candidate.targets as Record<string, unknown> | undefined;
      const chapters = candidate.chapters as Array<Record<string, unknown>> | undefined;
      const valid = isNonEmptyString(candidate.id)
        && !groupIds.has(candidate.id)
        && typeof candidate.enabled === 'boolean'
        && isNonEmptyString(source?.name)
        && isNonEmptyString(source?.instituteCode)
        && (targets?.mode === 'all_subjects_for_institute' || targets?.mode === 'specialty_for_institute')
        && isNonEmptyString(targets?.instituteCode)
        && (targets?.mode !== 'specialty_for_institute' || isNonEmptyString(targets?.specialty))
        && typeof candidate.includeInSubjectPractice === 'boolean'
        && Array.isArray(chapters)
        && chapters.length > 0
        && chapters.every(chapter => isNonEmptyString(chapter.name)
          && Number.isInteger(chapter.sortOrder)
          && Number(chapter.sortOrder) >= 0);
      if (!valid) throw new Error(`Invalid mapping group: ${String(candidate.id || 'unknown')}`);

      const normalizedChapterNames = chapters.map(chapter => String(chapter.name).trim().toLowerCase());
      if (new Set(normalizedChapterNames).size !== normalizedChapterNames.length) {
        throw new Error(`Duplicate chapter name in mapping group: ${candidate.id}`);
      }

      groupIds.add(candidate.id);
      groups.push({
        id: candidate.id.trim(),
        enabled: candidate.enabled,
        sourceSubject: {
          name: String(source.name).trim(),
          instituteCode: String(source.instituteCode).trim().toLowerCase(),
        },
        targets: {
          mode: targets.mode as 'all_subjects_for_institute' | 'specialty_for_institute',
          instituteCode: String(targets.instituteCode).trim().toLowerCase(),
          specialty: targets.specialty ? String(targets.specialty).trim().toLowerCase() : undefined,
        },
        includeInSubjectPractice: candidate.includeInSubjectPractice,
        contentType: (candidate.contentType === 'past_paper' || candidate.contentType === 'question_bank')
          ? candidate.contentType
          : 'question_bank',
        chapters: chapters.map(chapter => ({
          name: String(chapter.name).trim(),
          sortOrder: Number(chapter.sortOrder),
        })),
      });
    }

    cachedSharedQuestionBankGroups = groups.filter(group => group.enabled);
    return cachedSharedQuestionBankGroups;
  } catch (error) {
    console.error('Shared question-bank mapping could not be loaded; shared banks are disabled.', error);
    return [];
  }
};

const normalizeInstitute = (institute?: string | null) => String(institute || '').trim().toLowerCase();

const getInstituteYearOptions = (institute?: InstituteScope | null): string[] => (
  Array.isArray(institute?.years)
    ? institute.years.map(item => String(item).trim()).filter(Boolean)
    : []
);

const getSubjectInstitutes = <T extends SubjectLike>(subject: T): string[] => {
  const institutes = subject.institutes;

  if (!institutes || !Array.isArray(institutes) || institutes.length === 0) {
    return [];
  }

  return institutes.map(item => normalizeInstitute(item)).filter(Boolean);
};

const hasInstituteSpecificSubject = <T extends SubjectLike>(subject: T, institute?: string | null): boolean => {
  const normalized = getSubjectInstitutes(subject);
  const normalizedInstitute = normalizeInstitute(institute);

  if (!normalizedInstitute || normalized.length === 0 || normalized.includes('all') || normalized.includes('any')) {
    return false;
  }

  return normalized.includes(normalizedInstitute);
};

const getStringQuery = (value: string | string[] | undefined) => {
  if (Array.isArray(value)) return value[0];
  return value;
};

const getStringHeader = (value: string | string[] | undefined) => {
  if (Array.isArray(value)) return value[0];
  return value;
};

const normalizeMcqs = (rows: any[] | null) => (rows || []).map(mcq => ({
  ...mcq,
  options: Array.isArray(mcq.options)
    ? mcq.options
    : typeof mcq.options === 'string'
      ? JSON.parse(mcq.options)
      : [],
}));

const normalizeSeqs = (rows: any[] | null) => (rows || []).map(seq => ({
  ...seq,
  key_points: Array.isArray(seq.key_points)
    ? seq.key_points
    : typeof seq.key_points === 'string'
      ? JSON.parse(seq.key_points)
      : [],
}));

const setCors = (req: ContentRequest, res: ContentResponse) => {
  const origin = getStringHeader(req.headers.origin);
  const isAllowed = origin && (
    allowedOrigins.has(origin) ||
    origin.endsWith('.medmacs.app') ||
    origin.endsWith('.netlify.app') ||
    /^https?:\/\/localhost(:\d+)?$/i.test(origin)
  );

  if (isAllowed && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Cache-Control', 'private, max-age=30, stale-while-revalidate=120');
};

const getUserProfile = async (client: any) => {
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData?.user) {
    console.error('getUser failed:', userError);
    return null;
  }

  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('year, institute')
    .eq('id', userData.user.id)
    .single();

  if (profileError || !profile) {
    console.error('get profile row failed:', profileError);
    return null;
  }

  return profile as { year?: string | null; institute?: string | null };
};

const getInstituteScope = async (client: any, institute?: string | null): Promise<InstituteScope | null> => {
  const normalizedInstitute = normalizeInstitute(institute);
  if (!normalizedInstitute) return null;

  const { data, error } = await client
    .from('institutes')
    .select('category, years')
    .eq('code', normalizedInstitute)
    .maybeSingle();

  if (error) throw error;
  return data as InstituteScope | null;
};

const fetchScopedSubjects = async (client: any, table: string) => {
  const profile = await getUserProfile(client);
  if (!profile?.institute) {
    console.error('fetchScopedSubjects: Profile or institute missing', { profile });
    return [];
  }

  const instituteScope = await getInstituteScope(client, profile.institute);
  const yearOptions = getInstituteYearOptions(instituteScope);
  const normalizedProfileYear = String(profile?.year || '').trim();
  const effectiveYear = normalizedProfileYear || null;

  console.log('fetchScopedSubjects status:', {
    institute: profile.institute,
    yearOptions,
    profileYear: profile.year,
    effectiveYear
  });

  if (yearOptions.length > 0 && !effectiveYear) {
    console.warn('fetchScopedSubjects: Profile year is required but not selected');
    return [];
  }

  let query = client
    .from(table)
    .select('*')
    .order('name');

  if (effectiveYear) {
    query = query.eq('year', effectiveYear);
  }

  const { data, error } = await query;

  if (error) throw error;

  const subjects = (data || []) as SubjectRow[];
  const instituteSubjects = subjects.filter((subject: SubjectRow) => hasInstituteSpecificSubject(subject, profile.institute));

  if (instituteSubjects.length > 0) {
    return instituteSubjects;
  }

  if (yearOptions.length > 0 && !effectiveYear) {
    return [];
  }

  const generalSubjects = subjects.filter((subject: SubjectRow) => getSubjectInstitutes(subject).includes('all'));
  if (generalSubjects.length > 0) {
    return generalSubjects;
  }

  return subjects.filter((subject: SubjectRow) => {
    const institutes = getSubjectInstitutes(subject);
    return institutes.includes('smbb') || institutes.includes('smbbmc');
  });
};

const normalizeName = (value?: string | null) => String(value || '').trim().toLowerCase();

const resolveSourceSubject = async (client: any, group: SharedQuestionBankGroup): Promise<SubjectRow | null> => {
  const { data, error } = await client
    .from('subjects')
    .select('id, name, institutes')
    .ilike('name', group.sourceSubject.name);

  if (error) throw error;

  const matches = (data || []).filter((subject: SubjectRow) =>
    getSubjectInstitutes(subject).includes(group.sourceSubject.instituteCode),
  );

  if (matches.length !== 1) {
    console.error('Shared question-bank source must resolve exactly once; group disabled for this request.', {
      groupId: group.id,
      sourceName: group.sourceSubject.name,
      matches: matches.length,
    });
    return null;
  }

  return matches[0];
};

const resolveSharedChapters = async (
  client: any,
  targetSubject: SubjectRow,
  forSubjectPractice = false,
): Promise<ChapterRow[]> => {
  const resolved: ChapterRow[] = [];

  for (const group of getSharedQuestionBankGroups()) {
    if (forSubjectPractice && !group.includeInSubjectPractice) continue;
    if (!getSubjectInstitutes(targetSubject).includes(group.targets.instituteCode)) continue;

    // Filter shared past papers by specialty/year
    if (group.targets.mode === 'specialty_for_institute' && group.targets.specialty) {
      if (normalizeName(targetSubject.year) !== normalizeName(group.targets.specialty)) {
        continue;
      }
    }

    const sourceSubject = await resolveSourceSubject(client, group);
    if (!sourceSubject) continue;

    const { data, error } = await client
      .from('chapters')
      .select('id, name, description, chapter_number, subject_id, content_type, mcqs(count)')
      .eq('subject_id', sourceSubject.id);

    if (error) throw error;

    const sourceChapters = (data || []) as ChapterRow[];
    const chaptersByName = new Map<string, ChapterRow[]>();
    for (const chapter of sourceChapters) {
      const key = normalizeName(chapter.name);
      chaptersByName.set(key, [...(chaptersByName.get(key) || []), chapter]);
    }

    const groupChapters: ChapterRow[] = [];
    let groupIsComplete = true;
    for (const configuredChapter of group.chapters) {
      const matches = chaptersByName.get(normalizeName(configuredChapter.name)) || [];
      if (matches.length === 0) {
        console.error('Shared question-bank chapter must resolve; group disabled for this request.', {
          groupId: group.id,
          chapterName: configuredChapter.name,
        });
        groupIsComplete = false;
        break;
      }

      groupChapters.push({
        ...matches[0],
        chapter_number: configuredChapter.sortOrder,
        subject_id: targetSubject.id,
        content_type: group.contentType || 'question_bank',
      });
    }

    if (groupIsComplete) resolved.push(...groupChapters);
  }

  return resolved;
};

const fetchVisibleSubject = async (client: any, subjectId: string): Promise<SubjectRow | null> => {
  const subjects = await fetchScopedSubjects(client, 'subjects') as SubjectRow[];
  return subjects.find(subject => subject.id === subjectId) || null;
};

export default async function handler(req: ContentRequest, res: ContentResponse) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const resource = getStringQuery(req.query.resource);
  const subjectId = getStringQuery(req.query.subjectId);
  const chapterId = getStringQuery(req.query.chapterId);
  const authorization = getStringHeader(req.headers.authorization);

  console.log('API Request received:', {
    resource,
    subjectId,
    chapterId,
    hasAuthHeader: Boolean(authorization),
    authHeaderSample: authorization ? `${authorization.substring(0, 15)}...` : undefined,
    allHeaderKeys: Object.keys(req.headers)
  });

  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: authorization ? { headers: { Authorization: authorization } } : undefined,
  });

  try {
    switch (resource) {
      case 'mcq-subjects': {
        return res.status(200).json({ data: await fetchScopedSubjects(client, 'subjects') });
      }

      case 'mcq-subject': {
        if (!subjectId) return res.status(400).json({ error: 'subjectId is required' });
        const subject = await fetchVisibleSubject(client, subjectId);
        if (!subject) return res.status(404).json({ error: 'Subject not found' });
        return res.status(200).json({ data: subject });
      }

      case 'mcq-chapters': {
        if (!subjectId) return res.status(400).json({ error: 'subjectId is required' });
        const subject = await fetchVisibleSubject(client, subjectId);
        if (!subject) return res.status(404).json({ error: 'Subject not found' });
        const { data, error } = await client
          .from('chapters')
          .select('id, name, description, chapter_number, subject_id, content_type, mcqs(count)')
          .eq('subject_id', subjectId)
          .order('chapter_number');
        if (error) throw error;
        const sharedChapters = await resolveSharedChapters(client, subject);
        const chaptersById = new Map<string, ChapterRow>();
        for (const chapter of (data || []) as ChapterRow[]) chaptersById.set(chapter.id, chapter);
        for (const chapter of sharedChapters) chaptersById.set(chapter.id, chapter);

        return res.status(200).json({
          data: [...chaptersById.values()].sort((a, b) => a.chapter_number - b.chapter_number).map((chapter: ChapterRow) => ({
            ...chapter,
            mcq_count: chapter.mcqs?.[0]?.count || 0,
          })),
        });
      }

      case 'mcq-chapter': {
        if (!subjectId || !chapterId) {
          return res.status(400).json({ error: 'subjectId and chapterId are required' });
        }
        const subject = await fetchVisibleSubject(client, subjectId);
        if (!subject) return res.status(404).json({ error: 'Subject not found' });

        const { data: directChapter, error } = await client
          .from('chapters')
          .select('id, name, description, chapter_number, subject_id, content_type, mcqs(count)')
          .eq('id', chapterId)
          .eq('subject_id', subjectId)
          .maybeSingle();
        if (error) throw error;

        const sharedChapter = (await resolveSharedChapters(client, subject))
          .find(chapter => chapter.id === chapterId);
        const chapter = sharedChapter || directChapter;
        if (!chapter) return res.status(404).json({ error: 'Chapter not found' });

        return res.status(200).json({
          data: { ...chapter, mcq_count: chapter.mcqs?.[0]?.count || 0 },
        });
      }

      case 'mcqs': {
        if (!chapterId) return res.status(400).json({ error: 'chapterId is required' });

        const { data: chapterScope, error: chapterScopeError } = await client
          .from('chapters')
          .select('subject_id')
          .eq('id', chapterId)
          .maybeSingle();
        if (chapterScopeError) throw chapterScopeError;
        if (!chapterScope?.subject_id) return res.status(404).json({ error: 'Chapter not found' });

        const visibleSubject = await fetchVisibleSubject(client, chapterScope.subject_id);
        if (!visibleSubject) return res.status(404).json({ error: 'Chapter not found' });

        const { data, error } = await client
          .from('mcqs')
          .select('*')
          .eq('chapter_id', chapterId)
          .order('created_at');
        if (error) throw error;
        return res.status(200).json({ data: normalizeMcqs(data) });
      }

      case 'mcqs-by-subject': {
        if (!subjectId) return res.status(400).json({ error: 'subjectId is required' });

        const subject = await fetchVisibleSubject(client, subjectId);
        if (!subject) return res.status(404).json({ error: 'Subject not found' });

        const { data: chapters, error: chaptersError } = await client
          .from('chapters')
          .select('id')
          .eq('subject_id', subjectId);
        if (chaptersError) throw chaptersError;

        const sharedChapters = await resolveSharedChapters(client, subject, true);
        const chapterIds = [...new Set([
          ...(chapters || []).map((chapter: any) => chapter.id),
          ...sharedChapters.map(chapter => chapter.id),
        ])];
        if (chapterIds.length === 0) {
          return res.status(200).json({ data: [] });
        }

        const { data, error } = await client
          .from('mcqs')
          .select('*')
          .in('chapter_id', chapterIds);
        if (error) throw error;

        return res.status(200).json({ data: normalizeMcqs(data) });
      }

      case 'mcqs-by-subjects': {
        const subjectIdsStr = getStringQuery(req.query.subjectIds);
        if (!subjectIdsStr) return res.status(400).json({ error: 'subjectIds is required' });
        const subjectIds = subjectIdsStr.split(',').filter(Boolean);
        if (subjectIds.length === 0) return res.status(200).json({ data: [] });

        // Retrieve the scoped/visible subjects
        const allScopedSubjects = await fetchScopedSubjects(client, 'subjects') as SubjectRow[];
        const visibleSubjects = allScopedSubjects.filter(subj => subjectIds.includes(subj.id));

        if (visibleSubjects.length === 0) return res.status(200).json({ data: [] });

        // Get all chapters for these subjects
        const { data: chapters, error: chaptersError } = await client
          .from('chapters')
          .select('id, subject_id')
          .in('subject_id', visibleSubjects.map(s => s.id));
        if (chaptersError) throw chaptersError;

        // Resolve shared chapters for each visible subject
        const allSharedChaptersPromises = visibleSubjects.map(subj => resolveSharedChapters(client, subj, true));
        const sharedChaptersArrays = await Promise.all(allSharedChaptersPromises);
        const sharedChapters = sharedChaptersArrays.flat();

        const chapterIds = [...new Set([
          ...(chapters || []).map((chapter: any) => chapter.id),
          ...sharedChapters.map(chapter => chapter.id),
        ])];

        if (chapterIds.length === 0) {
          return res.status(200).json({ data: [] });
        }

        const { data, error } = await client
          .from('mcqs')
          .select('*')
          .in('chapter_id', chapterIds);
        if (error) throw error;

        return res.status(200).json({ data: normalizeMcqs(data) });
      }

      case 'app-seq-subjects': {
        return res.status(200).json({ data: await fetchScopedSubjects(client, 'seqs_subjects') });
      }

      case 'app-seq-chapters': {
        if (!subjectId) return res.status(400).json({ error: 'subjectId is required' });
        const { data, error } = await client
          .from('seqs_chapters')
          .select('id, name, description, chapter_number, subject_id, seqs(count)')
          .eq('subject_id', subjectId)
          .order('chapter_number');
        if (error) throw error;
        return res.status(200).json({
          data: (data || []).map((chapter: any) => ({
            ...chapter,
            seq_count: chapter.seqs?.[0]?.count || 0,
          })),
        });
      }

      case 'app-seqs': {
        if (!chapterId) return res.status(400).json({ error: 'chapterId is required' });
        const { data, error } = await client
          .from('seqs')
          .select('*')
          .eq('chapter_id', chapterId)
          .order('created_at');
        if (error) throw error;
        return res.status(200).json({ data: data || [] });
      }

      case 'seq-subjects': {
        return res.status(200).json({ data: await fetchScopedSubjects(client, 'subjects') });
      }

      case 'seq-chapters': {
        if (!subjectId) return res.status(400).json({ error: 'subjectId is required' });
        const { data, error } = await client
          .from('chapters')
          .select('id, name, description, chapter_number, subject_id, seq(count)')
          .eq('subject_id', subjectId)
          .order('chapter_number');
        if (error) throw error;
        return res.status(200).json({
          data: (data || []).map((chapter: any) => ({
            id: chapter.id,
            name: chapter.name,
            description: chapter.description,
            chapter_number: chapter.chapter_number,
            subject_id: chapter.subject_id,
            seq_count: chapter.seq?.[0]?.count || 0,
          })),
        });
      }

      case 'seqs': {
        if (!chapterId) return res.status(400).json({ error: 'chapterId is required' });
        const { data, error } = await client
          .from('seq')
          .select('*')
          .eq('chapter_id', chapterId)
          .order('created_at');
        if (error) throw error;
        return res.status(200).json({ data: normalizeSeqs(data) });
      }

      default:
        return res.status(400).json({ error: 'Unknown resource' });
    }
  } catch (error: any) {
    console.error('content api error', { resource, message: error?.message ?? error });
    return res.status(500).json({ error: 'Content service unavailable' });
  }
}
