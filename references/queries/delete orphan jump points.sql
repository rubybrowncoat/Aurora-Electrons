select * from FCT_Race where NPR = 0

select * from FCT_RaceJumpPointSurvey as thistable
where 
thistable.GameID = 41 and
thistable.RaceID not in (select RaceID from FCT_Race)
--delete from FCT_RaceJumpPointSurvey where RaceID = 215

select * from FCT_RaceTech as thistable
where 
thistable.GameID = 41 and
thistable.RaceID not in (select RaceID from FCT_Race)
--delete from FCT_RaceTech where RaceID = 215

select * from FCT_RuinRace as thistable
where 
thistable.GameID = 41 and
thistable.RaceID not in (select RaceID from FCT_Race)
--delete from FCT_RaceTech where RaceID = 215

select * from FCT_JumpPoint
WHERE
SystemID not in (select SystemID from FCT_System)
--2544-2547
--delete from FCT_JumpPoint WHERE SystemID not in (select SystemID from FCT_System)

select * from FCT_Star
WHERE
SystemID not in (select SystemID from FCT_System)
--3260-3264
--delete from FCT_Star WHERE SystemID not in (select SystemID from FCT_System)

select * from FCT_SystemBody
WHERE
SystemID not in (select SystemID from FCT_System)
--268 rows
--delete from FCT_SystemBody WHERE SystemID not in (select SystemID from FCT_System)


select * from FCT_RaceSysSurvey where RaceID = 220