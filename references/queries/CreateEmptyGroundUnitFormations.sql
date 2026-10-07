WITH RECURSIVE const AS 
(
	--This script creates any number of formations, at a colony you specify, using a formation template you specify, with the appropriate (empty) elements in each formation.
	
	------------------------------------------
	--Author: skoormit
	--Date: 20260602
	--Problems? Ideas? Find me on the Aurora Discord.
	------------------------------------------
	
	--IMPORTANT:
	--		This script assumes you are playing as the most recently created player race in the most recently created game in your database.
	--		If this is not the case, provide the appropriate GameID and RaceID values in the first two lines after the line below with only "select" .
	--Steps:
	-- 1) save Aurora, then save Aurora again (which makes a backup of the database at the current game time)
	-- 2) close Aurora
	-- 3) replace appropriate values in the select statement immediately below (PopulationName, FormationTemplateName, etc)
	-- 4) make sure the "INSERT INTO..." line just after the "COMMENT OUT THE FOLLOWING LINE FIRST" line is commented out ( begins with two dashes )
	-- 5) select all of the script from the very beginning until just before the "RUN IT TO HERE FIRST" line. run it (F5 in most software). It will return a list of the formations that will be created. Make sure it looks correct.
	-- 5b) select and run the 3-line select statement that follows the "MAKE SURE THIS RETURNS NOTHING" line. if that returns any rows, you already have existing formations that have no elements. you must fix that before proceeding. (either delete those formations or add elements to them.)
	-- 6) uncomment the line from step 4 (remove the "--" from the beginning)
	-- 7) run the script. you have now created the formations, with empty elements based on the formation template, at your designated colony.
	-- 8) commit the change to the database. (In DB Browser for SQLite, click the "Write Changes" button above.)
	-- 9) open Aurora and verify the new formations.
	-- 10) if something went wrong and you need to undo the changes:
	--		10a) Close Aurora (without saving) and delete AuroraDB.db from your game folder
	--		10b) In the same folder, rename AuroraDBSaveBackup.db to AuroraDB.db
	--		10c) Open Aurora. You will see the state the game was in prior to running the script.
	--
	
	
	select
		-- if you aren't playing the most recently created player race in the most recently created game in your database, replace the subselects in the following two lines with the appropriate values 
		(select max(GameID) from FCT_Game) as GameID
		,(select max(RaceID) from FCT_Race where NPR = 0) as RaceID
		--------------
		
		--------------change the values in these lines as needed
		,'ZZZ-A5%' as PopulationName							-- name of target colony
		,' Boardies100t - 2120' as FormationTemplateName			-- name of formation template
		,99 as ReplacementPriority									-- 10 is default. higher number is higher priority.
		,'adhoc boardies 100t zzza5 21221223' as FormationNamePrefix			-- what you want your formation names to begin with. this will be followed by a space and the formation number (below)
		,'brd' as FormationAbbreviation								-- the formation abbreviation to use
		,1 as StartingFormationNumber								--	this is a unique integer for each formation created by this script. it is appended to the formation name
		,55 as FormationsToCreate									-- how many formations to create
		
		
		--leave these lines alone
		,(select max(FormationID)+1 from FCT_GroundUnitFormation) as StartingFormationID
		,(select max(ElementID)+1 from FCT_GroundUnitFormationElement) as StartingElementID
		-------------------------
)

--select * from const

,CTE_IDs as
(
	select
		--c.PopulationName || '%',
		p.PopulationID
		,p.SpeciesID
		,g.TemplateID
		,g.RequiredRank
		,c.StartingFormationID
	from const as c
	inner join FCT_Population as p on p.PopName like c.PopulationName
	inner join FCT_GroundUnitFormationTemplate as g on g.Name = c.FormationTemplateName	
)

--select * from cte_IDs

,CTE_FormationTemplateElement as
(
	SELECT
		ClassID	
		,c.SpeciesID
		,row_number() over () as FormationTemplateElementNumber
	from
		FCT_GroundUnitFormationElementTemplates as gufet
	inner JOIN
		CTE_IDs as c
	on c.TemplateID = gufet.FormationTemplateID
)

--select * from CTE_FormationTemplateElement

,CTE_Formations as
(
	-- Anchor Member (Base Case)
  SELECT 
	c.StartingFormationNumber as FormationNumber 
	,cte.StartingFormationID as FormationID
	,c.FormationNamePrefix || ' ' || c.StartingFormationNumber as FormationName
	,cte.RequiredRank
	,c.ReplacementPriority
	,cte.TemplateID
	,cte.PopulationID
	,cte.SpeciesID
	from const as c
	inner join CTE_IDs as cte on 1=1	
  UNION ALL 
  --select FormationNumber+1 from CTE_FormationNumbers where FormationNumber<5
  -- Recursive step: Join the table back to the CTE to find subordinates
  SELECT 
	cte.FormationNumber + 1 
	,cte.FormationID + 1
	,c.FormationNamePrefix || ' ' || (cte.FormationNumber + 1 )
	,cte.RequiredRank
	,c.ReplacementPriority
	,cte.TemplateID
	,cte.PopulationID
	,cte.SpeciesID
	FROM const as c
 inner join CTE_Formations as cte on cte.FormationNumber < c.StartingFormationNumber + c.FormationsToCreate - 1
  
)

--COMMENT OUT THE FOLLOWING LINE FIRST
--INSERT INTO FCT_GroundUnitFormation (FormationID, Name, Abbreviation, RaceID, GameID, OriginalTemplateID, PopulationID, ShipID, ParentFormationID, BoardingStatus, HideSubUnits, FieldPosition, RequiredRank, AssignedFormationID, ActiveSensorsOn, Civilian, ReplacementTemplateID, UseForReplacements, ReplacementPriority, OrgLinkID, DoNotRecover)
SELECT
	cte.FormationID	as FormationID	
	,cte.FormationName as Name
	,c.FormationAbbreviation as Abbreviation
	,c.RaceID as RaceID
	,c.GameID as GameID
	,cte.TemplateID as OriginalTemplateID
	,cte.PopulationID as PopulationID
	,0 as ShipID
	,0 as ParentFormationID
	,0 as BoardingStatus
	,'False' as HideSubUnits
	,0 as FieldPosition
	,cte.RequiredRank as RequiredRank
	,0 as AssignedFormationID
	,0 as ActiveSensorsOn
	,0 as Civilian
	,cte.TemplateID as ReplacementTemplateID
	,0 as UseForReplacements
	,cte.ReplacementPriority as ReplacementPriority
	,0 as OrgLinkID
	,0 as DoNotRecover
FROM
	const as c
inner join CTE_Formations as cte on 1=1;



-- RUN IT TO HERE FIRST




-- Second part of script--adds empty elements to the new formations.
--
/*
with CTE_Formations as
(
	-- MAKE SURE THIS RETURNS NOTHING (before running first part of script)
	select * FROM FCT_GroundUnitFormation as f 
	left JOIN FCT_GroundUnitFormationElement as e on e.FormationID = f.FormationID
	WHERE e.FormationID is null
	---------------------------------
)

--select * from CTE_Formations

,CTE_Elements as
(
SELECT 
	f.GameID as GameID
	,f.FormationID as  FormationID
	,0 as  Units
	,gufet.ClassID as  ClassID
	,0 as  TemplateID
	,p.SpeciesID as  SpeciesID
	,100 as  Morale
	,1.0 as  FortificationLevel
	,10 as  CurrentSupply
	,1 as  TargetSelection
	,0 as  FiringDistribution
	,(se.StartingElementID-1) + (x.ElementsPerFormation * (f.FormationID-sf.StartingFormationID)) + gufet.FormationTemplateElementNumber as  ElementID
	
	,gufet.FormationTemplateElementNumber	
	,x.ElementsPerFormation
	,sf.StartingFormationID
	,se.StartingElementID
	
	--,f.*
FROM CTE_Formations as f
inner join FCT_Population as p on p.PopulationID = f.PopulationID
inner join (select min(FormationID) as StartingFormationID from CTE_Formations) as sf on 1=1
inner join (select max(ElementID)+1 as StartingElementID from FCT_GroundUnitFormationElement)  as se on 1=1
inner join (select FormationTemplateID, count(*) as ElementsPerFormation from FCT_GroundUnitFormationElementTemplates group by FormationTemplateID) as x on x.FormationTemplateID = f.OriginalTemplateID
inner JOIN 
(
	select 
		ClassID
		, FormationTemplateID
		, row_number() over (PARTITION BY FormationTemplateID) as FormationTemplateElementNumber 
	FROM	
		FCT_GroundUnitFormationElementTemplates
) as gufet on gufet.FormationTemplateID = f.OriginalTemplateID
order by
	f.FormationID
	,gufet.FormationTemplateElementNumber
)	

--select * from CTE_Elements
	
--INSERT INTO FCT_GroundUnitFormationElement	(GameID, FormationID, Units, ClassID, TemplateID, SpeciesID, Morale, FortificationLevel, CurrentSupply, TargetSelection, FiringDistribution, ElementID)
SELECT 											 GameID, FormationID, Units, ClassID, TemplateID, SpeciesID, Morale, FortificationLevel, CurrentSupply, TargetSelection, FiringDistribution, ElementID
from CTE_Elements;

--*/
