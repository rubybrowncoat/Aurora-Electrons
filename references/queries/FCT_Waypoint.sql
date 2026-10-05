BEGIN TRANSACTION;
DROP TABLE IF EXISTS "FCT_Waypoint";
CREATE TABLE IF NOT EXISTS "FCT_Waypoint" (
	"WaypointID"	Integer,
	"GameID"	Integer DEFAULT NULL,
	"RaceID"	Integer DEFAULT NULL,
	"SystemID"	Integer DEFAULT NULL,
	"OrbitBodyID"	Integer DEFAULT 0,
	"CreationTime"	Double DEFAULT 0,
	"Xcor"	Double DEFAULT NULL,
	"Ycor"	Double DEFAULT NULL,
	"Number"	Integer DEFAULT 0,
	"WaypointType"	Integer DEFAULT 0,
	"Name"	Text,
	"JumpPointID"	Integer DEFAULT 0,
	PRIMARY KEY("WaypointID" AUTOINCREMENT)
);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (344,116,599,13420,0,548968555.0,-26902326.6768923,-74167645.9813164,2,0,'CAB fleet 2042-05-25',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (376,116,599,13420,0,551990505.0,-822809395.113136,-394225848.577235,7,0,'CAB Grove 2042-06-29.',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (377,116,599,13417,0,716934015.0,-186172391.858893,-508403767.320736,1,0,'Grove initial contact 2047-09-20',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (387,116,599,13417,0,717030585.0,-146001181.40972,-364653941.155731,3,0,'Calpe Disabled 2047-09-21',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (395,116,599,13417,0,717101135.0,-539147315.048821,-1368543133.7677,11,0,'grove projected path',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (399,116,599,13417,0,717146975.0,-186569884.6821,-509826169.497743,12,0,'Grove stopping point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (406,116,599,13426,0,790860500.0,473677016.220007,-729398631.785469,1,6,'cac-cad',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (407,116,596,13448,1221373,797687515.0,57986097.7878835,171769210.81088,1,1,'POI - Cader Idris I',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (408,116,596,13448,1221397,797626820.0,350385773.146453,-9723360.70075813,2,1,'POI - Cader Idris II',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (409,116,596,13448,1221398,797626820.0,-473976042.12365,-326334600.69978,3,1,'POI - Cader Idris III',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (410,116,596,13448,1221399,797626820.0,566029347.08462,994842946.728664,4,1,'POI - Cader Idris IV',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (411,116,596,13448,0,797686260.0,-74482430.0497247,126734136.587266,5,2,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (414,116,596,13448,0,797689095.0,-96946910.4888678,144846861.219447,6,2,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (423,116,599,13448,0,797691160.0,-27925121.6144832,-157853848.535583,1,0,'20mkm w of JP Cafu',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (424,116,599,13448,0,797721565.0,-47851867.811515,-157736402.094343,2,0,'40mkm w of JP Cafu',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (425,116,599,13448,0,797741445.0,-24049668.1885111,-6167217019.78138,3,8,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (426,116,599,13448,0,798858715.0,-3856745.82048762,-6167580110.47194,4,8,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (427,116,599,13448,0,798862315.0,-48835.2129749595,-6172610130.26495,5,8,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (428,116,599,13448,0,798863035.0,2627915.3233517,-6170661937.56637,6,8,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (429,116,599,13448,0,798863405.0,3625598.59882554,-6169918540.28925,7,8,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (430,116,599,13448,0,798863530.0,3674209.41116478,-6168832120.75936,8,8,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (431,116,599,13448,0,798864200.0,6842221.92424641,-6165701856.32889,9,8,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (432,116,599,13448,0,798864955.0,10388578.6772355,-6161413522.5517,10,8,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (433,116,599,13448,0,798865085.0,9568338.45859681,-6159926443.30457,11,8,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (434,116,599,13448,0,798866165.0,13061432.1126327,-6150784843.36827,12,8,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (435,116,599,13448,0,798867485.0,15289365.4826372,-6103118645.42287,13,8,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (438,116,596,13448,0,799985045.0,-8276147.00459064,-157918292.242325,7,1,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (439,116,599,13440,0,799982635.0,-3828111017.21495,-3569771274.94689,1,6,'New Waypoint',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (440,116,596,13448,0,800271346.0,-8276147.00459064,-157918292.242325,8,2,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (441,116,596,13448,0,799982783.0,-8276147.00459064,-157918292.242325,9,3,'',37234);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (442,116,596,13448,0,799984620.0,-8283305.77229413,-152756924.528749,10,1,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (443,116,596,13448,0,799984120.0,-8282713.35456994,-153184049.117911,11,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (444,116,596,13448,0,799984125.0,-8282694.71343628,-153197489.104983,12,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (445,116,596,13448,0,799984130.0,-8282676.07230262,-153210929.092056,13,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (446,116,596,13448,0,799984135.0,-8282657.43116896,-153224369.079128,14,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (447,116,596,13448,0,799984140.0,-8282638.79003531,-153237809.066201,15,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (448,116,596,13448,0,799984145.0,-8282620.14890165,-153251249.053273,16,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (449,116,596,13448,0,799984150.0,-8282601.50776799,-153264689.040346,17,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (450,116,596,13448,0,799984155.0,-8282582.86663433,-153278129.027418,18,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (451,116,596,13448,0,799984160.0,-8282564.22550068,-153291569.014491,19,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (452,116,596,13448,0,799984165.0,-8282545.58436702,-153305009.001563,20,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (453,116,596,13448,0,799984170.0,-8282526.94323336,-153318448.988636,21,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (454,116,596,13448,0,799984175.0,-8282508.3020997,-153331888.975708,22,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (455,116,596,13448,0,799984180.0,-8282489.66096604,-153345328.962781,23,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (456,116,596,13448,0,799984185.0,-8282471.01983239,-153358768.949853,24,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (457,116,596,13448,0,799984190.0,-8282452.37869873,-153372208.936926,25,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (458,116,596,13448,0,799984195.0,-8282433.73756507,-153385648.923998,26,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (459,116,596,13448,0,799984200.0,-8282415.09643141,-153399088.911071,27,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (460,116,596,13448,0,799984205.0,-8282396.45529776,-153412528.898143,28,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (461,116,596,13448,0,799984210.0,-8282377.8141641,-153425968.885216,29,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (462,116,596,13448,0,799984215.0,-8282359.17303044,-153439408.872288,30,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (463,116,596,13448,0,799984220.0,-8282340.53189678,-153452848.859361,31,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (464,116,596,13448,0,799984225.0,-8282321.89076313,-153466288.846433,32,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (465,116,596,13448,0,799984230.0,-8282303.24962947,-153479728.833506,33,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (466,116,596,13448,0,799984235.0,-8282284.60849581,-153493168.820578,34,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (467,116,596,13448,0,799984240.0,-8282265.96736215,-153506608.807651,35,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (468,116,596,13448,0,799984245.0,-8282247.3262285,-153520048.794723,36,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (469,116,596,13448,0,799984250.0,-8282228.68509484,-153533488.781796,37,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (470,116,596,13448,0,799984255.0,-8282210.04396118,-153546928.768868,38,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (471,116,596,13448,0,799984260.0,-8282191.40282752,-153560368.755941,39,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (472,116,596,13448,0,799984265.0,-8282172.76169386,-153573808.743013,40,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (473,116,596,13448,0,799984270.0,-8282154.12056021,-153587248.730086,41,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (474,116,596,13448,0,799984275.0,-8282135.47942655,-153600688.717158,42,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (475,116,596,13448,0,799984280.0,-8282116.83829289,-153614128.704231,43,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (476,116,596,13448,0,799984285.0,-8282098.19715923,-153627568.691303,44,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (477,116,596,13448,0,799984290.0,-8282079.55602558,-153641008.678376,45,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (478,116,596,13448,0,799984295.0,-8282060.91489192,-153654448.665448,46,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (479,116,596,13448,0,799984300.0,-8282042.27375826,-153667888.652521,47,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (480,116,596,13448,0,799984305.0,-8282023.6326246,-153681328.639593,48,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (481,116,596,13448,0,799984310.0,-8282004.99149095,-153694768.626666,49,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (482,116,596,13448,0,799984315.0,-8281986.35035729,-153708208.613738,50,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (483,116,596,13448,0,799984320.0,-8281967.70922363,-153721648.600811,51,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (484,116,596,13448,0,799984325.0,-8281949.06808997,-153735088.587883,52,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (485,116,596,13448,0,799984330.0,-8281930.42695632,-153748528.574956,53,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (486,116,596,13448,0,799984335.0,-8281911.78582266,-153761968.562028,54,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (487,116,596,13448,0,799984340.0,-8281893.144689,-153775408.549101,55,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (488,116,596,13448,0,799984345.0,-8281874.50355534,-153788848.536173,56,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (489,116,596,13448,0,799984350.0,-8281855.86242168,-153802288.523246,57,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (490,116,596,13448,0,799984355.0,-8281837.22128803,-153815728.510318,58,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (491,116,596,13448,0,799984360.0,-8281818.58015437,-153829168.497391,59,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (492,116,596,13448,0,799984365.0,-8281799.93902071,-153842608.484463,60,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (493,116,596,13448,0,799984370.0,-8281781.29788705,-153856048.471536,61,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (494,116,596,13448,0,799984375.0,-8281762.6567534,-153869488.458608,62,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (495,116,596,13448,0,799984380.0,-8281744.01561974,-153882928.445681,63,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (496,116,596,13448,0,799984385.0,-8281725.37448608,-153896368.432753,64,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (497,116,596,13448,0,799984390.0,-8281706.73335242,-153909808.419826,65,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (498,116,596,13448,0,799984395.0,-8281688.09221877,-153923248.406898,66,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (499,116,596,13448,0,799984400.0,-8281669.45108511,-153936688.393971,67,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (500,116,596,13448,0,799984405.0,-8281650.80995145,-153950128.381043,68,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (501,116,596,13448,0,799984410.0,-8281632.16881779,-153963568.368116,69,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (502,116,596,13448,0,799984415.0,-8281613.52768414,-153977008.355188,70,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (503,116,596,13448,0,799984420.0,-8281594.88655048,-153990448.342261,71,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (504,116,596,13448,0,799984425.0,-8281576.24541682,-154003888.329333,72,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (505,116,596,13448,0,799984430.0,-8281557.60428316,-154017328.316406,73,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (506,116,596,13448,0,799984435.0,-8281538.9631495,-154030768.303478,74,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (507,116,596,13448,0,799984440.0,-8281520.32201585,-154044208.290551,75,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (508,116,596,13448,0,799984445.0,-8281501.68088219,-154057648.277623,76,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (509,116,596,13448,0,799984450.0,-8281483.03974853,-154071088.264696,77,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (510,116,596,13448,0,799984455.0,-8281464.39861487,-154084528.251768,78,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (511,116,596,13448,0,799984460.0,-8281445.75748122,-154097968.238841,79,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (512,116,596,13448,0,799984465.0,-8281427.11634756,-154111408.225913,80,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (513,116,596,13448,0,799984470.0,-8281408.4752139,-154124848.212986,81,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (514,116,596,13448,0,799984475.0,-8281389.83408024,-154138288.200058,82,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (515,116,596,13448,0,799984480.0,-8281371.19294659,-154151728.187131,83,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (516,116,596,13448,0,799984485.0,-8281352.55181293,-154165168.174203,84,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (517,116,596,13448,0,799984490.0,-8281333.91067927,-154178608.161276,85,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (518,116,596,13448,0,799984495.0,-8281315.26954561,-154192048.148348,86,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (519,116,596,13448,0,799984500.0,-8281296.62841196,-154205488.135421,87,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (520,116,596,13448,0,799984505.0,-8281277.9872783,-154218928.122493,88,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (521,116,596,13448,0,799984510.0,-8281259.34614464,-154232368.109566,89,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (522,116,596,13448,0,799984515.0,-8281240.70501098,-154245808.096638,90,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (523,116,596,13448,0,799984520.0,-8281222.06387732,-154259248.083711,91,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (524,116,596,13448,0,799984525.0,-8281203.42274367,-154272688.070783,92,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (525,116,596,13448,0,799984530.0,-8281184.78161001,-154286128.057856,93,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (526,116,596,13448,0,799984535.0,-8281166.14047635,-154299568.044928,94,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (527,116,596,13448,0,799984540.0,-8281147.49934269,-154313008.032001,95,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (528,116,596,13448,0,799984545.0,-8281128.85820904,-154326448.019073,96,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (529,116,596,13448,0,799984550.0,-8281110.21707538,-154339888.006146,97,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (530,116,596,13448,0,799984555.0,-8281091.57594172,-154353327.993218,98,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (531,116,596,13448,0,799984560.0,-8281072.93480806,-154366767.980291,99,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (532,116,596,13448,0,799984565.0,-8281054.29367441,-154380207.967363,100,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (533,116,596,13448,0,799984570.0,-8281035.65254075,-154393647.954436,101,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (534,116,596,13448,0,799984575.0,-8281017.01140709,-154407087.941508,102,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (535,116,596,13448,0,799984580.0,-8280998.37027343,-154420527.928581,103,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (536,116,596,13448,0,799984585.0,-8280979.72913977,-154433967.915653,104,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (537,116,596,13448,0,799984590.0,-8280961.08800612,-154447407.902726,105,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (538,116,596,13448,0,799984595.0,-8280942.44687246,-154460847.889798,106,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (539,116,596,13448,0,799984600.0,-8280923.8057388,-154474287.876871,107,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (540,116,596,13448,0,799984605.0,-8280905.16460514,-154487727.863943,108,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (541,116,596,13448,0,799984610.0,-8280886.52347149,-154501167.851016,109,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (542,116,596,13448,0,799984615.0,-8280867.88233783,-154514607.838088,110,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (543,116,596,13448,0,799984620.0,-8280849.24120417,-154528047.825161,111,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (544,116,596,13448,0,799984625.0,-8280830.60007051,-154541487.812233,112,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (545,116,596,13448,0,799984630.0,-8280811.95893686,-154554927.799306,113,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (546,116,596,13448,0,799984635.0,-8280793.3178032,-154568367.786378,114,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (547,116,596,13448,0,799984640.0,-8280774.67666954,-154581807.773451,115,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (548,116,596,13448,0,799984645.0,-8280756.03553588,-154595247.760523,116,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (549,116,596,13448,0,799984650.0,-8280737.39440223,-154608687.747596,117,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (550,116,596,13448,0,799984655.0,-8280718.75326857,-154622127.734668,118,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (551,116,596,13448,0,799984660.0,-8280700.11213491,-154635567.721741,119,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (552,116,596,13448,0,799984665.0,-8280681.47100125,-154649007.708813,120,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (553,116,596,13448,0,799984670.0,-8280662.82986759,-154662447.695886,121,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (554,116,596,13448,0,799984675.0,-8280644.18873394,-154675887.682958,122,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (555,116,596,13448,0,799984680.0,-8280625.54760028,-154689327.670031,123,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (556,116,596,13448,0,799984685.0,-8280606.90646662,-154702767.657103,124,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (557,116,596,13448,0,799984690.0,-8280588.26533296,-154716207.644176,125,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (558,116,596,13448,0,799984695.0,-8280569.62419931,-154729647.631248,126,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (559,116,596,13448,0,799984700.0,-8280550.98306565,-154743087.618321,127,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (560,116,596,13448,0,799984705.0,-8280532.34193199,-154756527.605393,128,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (561,116,596,13448,0,799984710.0,-8280513.70079833,-154769967.592466,129,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (562,116,596,13448,0,799984715.0,-8280495.05966468,-154783407.579538,130,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (563,116,596,13448,0,799984720.0,-8280476.41853102,-154796847.566611,131,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (564,116,596,13448,0,799984725.0,-8280457.77739736,-154810287.553683,132,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (565,116,596,13448,0,799984730.0,-8280439.1362637,-154823727.540756,133,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (566,116,596,13448,0,799984735.0,-8280420.49513005,-154837167.527828,134,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (567,116,596,13448,0,799984740.0,-8280401.85399639,-154850607.514901,135,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (568,116,596,13448,0,799984745.0,-8280383.21286273,-154864047.501973,136,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (569,116,596,13448,0,799984750.0,-8280364.57172907,-154877487.489046,137,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (570,116,596,13448,0,799984755.0,-8280345.93059541,-154890927.476118,138,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (571,116,596,13448,0,799984760.0,-8280327.28946176,-154904367.463191,139,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (572,116,596,13448,0,799984765.0,-8280308.6483281,-154917807.450263,140,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (573,116,596,13448,0,799984770.0,-8280290.00719444,-154931247.437336,141,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (574,116,596,13448,0,799984775.0,-8280271.36606078,-154944687.424408,142,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (575,116,596,13448,0,799984780.0,-8280252.72492713,-154958127.411481,143,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (576,116,596,13448,0,799984785.0,-8280234.08379347,-154971567.398553,144,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (577,116,596,13448,0,799984790.0,-8280215.44265981,-154985007.385626,145,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (578,116,596,13448,0,799984795.0,-8280196.80152615,-154998447.372698,146,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (579,116,596,13448,0,799984800.0,-8280178.1603925,-155011887.359771,147,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (580,116,596,13448,0,799984805.0,-8280159.51925884,-155025327.346843,148,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (581,116,596,13448,0,799984810.0,-8280140.87812518,-155038767.333916,149,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (582,116,596,13448,0,799984815.0,-8280122.23699152,-155052207.320988,150,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (583,116,596,13448,0,799984820.0,-8280103.59585787,-155065647.308061,151,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (584,116,596,13448,0,799984825.0,-8280084.95472421,-155079087.295133,152,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (585,116,596,13448,0,799984830.0,-8280066.31359055,-155092527.282206,153,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (586,116,596,13448,0,799984835.0,-8280047.67245689,-155105967.269278,154,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (587,116,596,13448,0,799984840.0,-8280029.03132323,-155119407.256351,155,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (588,116,596,13448,0,799984845.0,-8280010.39018958,-155132847.243423,156,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (589,116,596,13448,0,799984850.0,-8279991.74905592,-155146287.230496,157,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (590,116,596,13448,0,799984855.0,-8279973.10792226,-155159727.217568,158,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (591,116,596,13448,0,799984860.0,-8279954.4667886,-155173167.204641,159,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (592,116,596,13448,0,799984865.0,-8279935.82565495,-155186607.191713,160,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (593,116,596,13448,0,799984870.0,-8279917.18452129,-155200047.178786,161,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (594,116,596,13448,0,799984875.0,-8279898.54338763,-155213487.165858,162,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (595,116,596,13448,0,799984880.0,-8279879.90225397,-155226927.152931,163,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (596,116,596,13448,0,799984885.0,-8279861.26112032,-155240367.140003,164,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (597,116,596,13448,0,799984890.0,-8279842.61998666,-155253807.127076,165,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (598,116,596,13448,0,799984895.0,-8279823.978853,-155267247.114148,166,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (599,116,596,13448,0,799984900.0,-8279805.33771934,-155280687.101221,167,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (600,116,596,13448,0,799984905.0,-8279786.69658569,-155294127.088293,168,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (601,116,596,13448,0,799984910.0,-8279768.05545203,-155307567.075366,169,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (602,116,596,13448,0,799984915.0,-8279749.41431837,-155321007.062438,170,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (603,116,596,13448,0,799984920.0,-8279730.77318471,-155334447.049511,171,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (604,116,596,13448,0,799984925.0,-8279712.13205105,-155347887.036583,172,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (605,116,596,13448,0,799984930.0,-8279693.4909174,-155361327.023656,173,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (606,116,596,13448,0,799984935.0,-8279674.84978374,-155374767.010728,174,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (607,116,596,13448,0,799984940.0,-8279656.20865008,-155388206.997801,175,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (608,116,596,13448,0,799984945.0,-8279637.56751642,-155401646.984873,176,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (609,116,596,13448,0,799984950.0,-8279618.92638277,-155415086.971946,177,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (610,116,596,13448,0,799984955.0,-8279600.28524911,-155428526.959018,178,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (611,116,596,13448,0,799984960.0,-8279581.64411545,-155441966.946091,179,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (612,116,596,13448,0,799984965.0,-8279563.00298179,-155455406.933163,180,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (613,116,596,13448,0,799984970.0,-8279544.36184814,-155468846.920236,181,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (614,116,596,13448,0,799984975.0,-8279525.72071448,-155482286.907308,182,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (615,116,596,13448,0,799984980.0,-8279507.07958082,-155495726.894381,183,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (616,116,596,13448,0,799984985.0,-8279488.43844716,-155509166.881453,184,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (617,116,596,13448,0,799984990.0,-8279469.79731351,-155522606.868526,185,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (618,116,596,13448,0,799984995.0,-8279451.15617985,-155536046.855598,186,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (619,116,596,13448,0,799985000.0,-8279432.51504619,-155549486.842671,187,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (620,116,596,13448,0,799985005.0,-8279413.87391253,-155562926.829743,188,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (621,116,596,13448,0,799985010.0,-8279395.23277887,-155576366.816816,189,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (622,116,596,13448,0,799985015.0,-8279376.59164522,-155589806.803888,190,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (623,116,596,13448,0,799985020.0,-8279357.95051156,-155603246.79096,191,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (624,116,596,13448,0,799985025.0,-8279339.3093779,-155616686.778033,192,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (625,116,596,13448,0,799985030.0,-8279320.66824424,-155630126.765105,193,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (626,116,596,13448,0,799985035.0,-8279302.02711059,-155643566.752178,194,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (627,116,596,13448,0,799985040.0,-8279283.38597693,-155657006.739251,195,8,'RD-11 Maria Goeppert-Mayer 011 Escape Point',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (628,116,596,13448,0,801315406.0,-8274896.56921235,-152687389.054339,196,2,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (2315,117,607,13641,0,516561150.0,3576552840.3474,-2322640571.36316,1,6,'caa-cea',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (2930,117,601,13630,0,607991335.0,-1282827604.9264,1824224955.48473,21,1,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (3400,117,607,13621,0,568187565.0,608696597.621693,3214983972.02653,2,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (3401,117,607,13621,0,568187565.0,2923046597.62169,8201658972.02653,3,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (3405,117,607,13621,0,569670945.0,2930551855.33258,8200537673.22885,5,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (3406,117,607,13621,0,569670945.0,2934259081.89508,8197586525.76792,6,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (3407,117,607,13621,0,569670945.0,2935689941.27008,8193293947.64292,7,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (3408,117,607,13621,0,569670945.0,2934421679.55133,8188513576.54917,8,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (3422,117,607,13621,0,571131970.0,1992349140.42676,6233791537.87905,17,0,'turnaround',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (4196,117,607,13621,0,572208620.0,1993060423.22608,6234572221.26964,18,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (4197,117,607,13621,0,572208620.0,1993946580.45264,6235068144.1212,19,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (4198,117,607,13621,0,572208620.0,1994970945.68702,6235247001.54307,20,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (4199,117,607,13621,0,572208620.0,1995987181.03858,6235165702.71495,21,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (4200,117,607,13621,0,572208620.0,1996889598.03077,6234799857.98839,22,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (4202,117,607,13621,0,572208620.0,1997678196.66358,6234161662.1876,23,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (4203,117,607,13621,0,572208620.0,1998141599.98389,6233247050.3712,24,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (4204,117,607,13621,0,572208620.0,1998092820.68702,6232222685.13682,25,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (5627,117,607,13621,0,573182125.0,593090292.41365,1132114838.64312,26,0,'turnaround2',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (5628,117,607,13621,0,573182125.0,592476813.7666,1131273837.68373,27,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (5629,117,607,13621,0,573182125.0,591505292.770506,1130964902.13686,28,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (5630,117,607,13621,0,573182125.0,590537836.715819,1131086850.37905,29,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (5631,117,607,13621,0,573182125.0,589659809.372069,1131562448.52358,30,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (5632,117,607,13621,0,573182125.0,589054133.102538,1132379501.74623,31,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (5633,117,607,13621,0,573182125.0,589224860.6416,1133489230.75014,32,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (5634,117,607,13621,0,573182125.0,2918916617.15294,8200358190.77653,33,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (5635,117,607,13621,0,573182125.0,2916542691.37169,8197366393.90153,34,0,'turnaround B',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (5898,117,604,13621,0,580943249.0,591158709.245193,1125008519.31285,2494,2,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (8905,117,601,13630,0,607581560.0,-1290021193.02149,1842341195.46873,30,1,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (8906,117,601,13534,0,607581540.0,-4581301308.38468,-2435921114.95121,1,1,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (12778,117,601,13630,0,606652095.0,-1274919005.07986,1813647775.90274,32,1,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (13962,117,604,13621,0,580943520.0,593090292.41365,1132114838.64312,10125,2,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (14954,117,604,13621,0,580803900.0,813589501.833438,799997640.144478,11112,2,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (15693,117,604,13621,0,580805940.0,808367992.564664,794461936.531021,11851,2,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (16108,117,607,13621,0,580871865.0,589944355.270506,1134151816.19936,35,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (16109,117,607,13621,0,580871865.0,591066279.098631,1134265634.55874,36,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (16110,117,607,13621,0,580871865.0,591895527.145506,1134143686.31655,37,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (16111,117,607,13621,0,580871865.0,592684125.778319,1133672153.11342,38,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (16112,117,607,13621,0,580871865.0,592928022.262694,1133013632.60561,39,0,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (16940,117,604,13621,0,581084545.0,-171867254.40611,1031408290.4339,13090,2,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (16941,117,607,13621,0,581084545.0,-177875871.977397,1030611352.98678,41,0,'INT Disappeared',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (17268,117,607,13638,0,589194070.0,64533627.8022652,262692578.839445,2,0,'2043-09-03 Glaive Lost',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (17269,117,607,13638,0,589194070.0,-34273012.8227348,246780860.089445,3,0,'2043-09-03 Glaive Initial',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (17409,117,601,13630,0,602899655.0,-1263430353.39858,1799835038.65892,34,1,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (17535,117,604,13494,0,596021405.0,-225737864.047256,-445425252.852478,1,2,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (17536,117,604,13494,0,596022845.0,-279634013.241852,-427069561.159179,2,2,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (17538,117,601,13630,0,606772050.0,-1257909987.83613,1794137877.8148,37,1,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (17542,117,604,13494,0,596037605.0,-194534830.303016,-456052232.253862,5,2,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (17803,117,601,13630,0,607942175.0,-1276885055.45987,1824330443.35465,40,1,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (17922,117,601,13630,0,607971995.0,-1269913228.80347,1815653269.99584,41,1,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (17957,117,604,13659,1240635,604871765.0,72964483.1466802,79828884.8234269,1,1,'POI - Big Cow Creek I',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (17958,117,604,13659,1240637,605254211.0,-318097641.866787,-233982328.662912,2,1,'POI - Big Cow Creek II',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (17959,117,604,13659,1240639,604871765.0,1195790559.40058,1299473728.53031,3,1,'POI - Big Cow Creek III',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (17980,117,607,13659,0,605248685.0,-323636234.626019,-317050259.546852,1,0,'2044-03-07 04:38:05 Glaive',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (17984,117,601,13630,0,607089280.0,-1264176200.11678,1808529701.08774,42,1,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (17985,117,604,13659,0,605255495.0,-278469140.567606,-279041367.411306,4,2,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (17989,117,607,13659,0,605254925.0,-8272490274.06243,-277764128.952877,6,0,'TurnaroundA',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (18093,117,607,13659,0,606717535.0,-8273441577.77259,-277470233.362105,7,0,'TurnaroundA 1',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (18094,117,607,13659,0,606717535.0,-8273755083.63197,-276508094.69023,8,0,'TurnaroundA 2',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (18095,117,607,13659,0,606717535.0,-8273744273.08509,-275497308.557417,9,0,'TurnaroundA 3',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (18096,117,607,13659,0,606717535.0,-8273441577.77259,-274532467.248823,10,0,'TurnaroundA 4',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (18097,117,607,13659,0,606717535.0,-8272487547.01087,-274218961.389448,11,0,'TurnaroundA 5',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (18098,117,607,13659,0,606720165.0,-1253572424.94056,-274375714.319136,12,0,'TurnaroundB',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (18099,117,601,13630,0,606772930.0,-1257638008.97306,1800874268.71558,43,1,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (18114,117,607,13648,0,607598190.0,-2523308498.27436,1468795262.41685,1,6,'sadfadfasdfasfd',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (18115,117,603,13534,0,607986295.0,-4581301308.38468,-2435921114.95121,1,1,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (18121,117,603,13630,0,607986295.0,-1290021193.02149,1842341195.46873,1,1,'',0);
INSERT INTO "FCT_Waypoint" ("WaypointID","GameID","RaceID","SystemID","OrbitBodyID","CreationTime","Xcor","Ycor","Number","WaypointType","Name","JumpPointID") VALUES (55585,NULL,NULL,NULL,0,0.0,NULL,NULL,0,0,NULL,0);
DROP VIEW IF EXISTS "vw_cycling";
CREATE VIEW vw_cycling as

WITH CTE_ShipClassCargoCapacity as
(
	SELECT
		sc.ShipClassID
		,sum(cc.NumComponent * sdc.ComponentValue) as CargoCapacity
		--,sdc.*
	FROM		
		FCT_ShipClass as sc
	inner JOIN (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace on CurrentRace.RaceID = sc.RaceID
	inner JOIN FCT_ClassComponent as cc on	cc.ClassID = sc.ShipClassID
	inner JOIN FCT_ShipDesignComponents as sdc on sdc.SDComponentID = cc.ComponentID AND sdc.ComponentTypeID in (4,17)
	group by sc.ShipClassID		
),

CTE_TankerClassMuleCapacity as 
(
	select
		sc.ShipClassID
		,sc.ClassName
		,sc.FuelCapacity/1000.0/1000 as FuelCapacityML
		,sc.EnginePower
		,sc.FuelEfficiency
		,sc.MinimumFuel/1000.0/1000 as MinimumFuelML
		,sc.MaxSpeed
		,sc.MaxSpeed * 3600 / sc.EnginePower / sc.FuelEfficiency /1000/1000/1000 *1000*1000 as BkmPerML
		, sc.EnginePower * sc.FuelEfficiency / sc.MaxSpeed / 3600 *1000*1000*1000 /1000/1000 as MLPerBkm
		,sc.*
	FROM
	FCT_ShipClass as sc
	inner JOIN (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace on CurrentRace.RaceID = sc.RaceID
	inner JOIN FCT_HullDescription as hd on hd.HullDescriptionID = sc.HullDescriptionID
	where hd.HullAbbr in ('TK','FTK')
)

SELECT
	flt.FleetType
	,flt.FleetDesignator
	,flt.FleetShipCount
	,flt.FleetName
	--,substr(FleetCapacity.ClassName,1,instr(FleetCapacity.ClassName,' ')-1) as ClassName
	,fleetCapacity.ClassName
	,flt.FleetSourceName
	,flt.FleetDestinationName
	,flt.FleetDestinationSystem
	,flt.FleetDestinationBody	
	,flt.Cargo
	,FleetCapacity.CargoCapacity
	,cast(flt.Rate as float) as Rate
	,FleetCapacity.FuelCapacityML
	,FleetCapacity.MLPerBkm
	,FleetCapacity.MinimumFuelML
	/*
	,flt.RaceID
	,flt.FleetID
	,CASE
		WHEN mo_load.MoveActionID = 4 then 'mpop'
		else pi.Name 
	END as Cargo
	*/
FROM
(
	SELECT
		flt.FleetType
		,flt.FleetDesignator
		,flt.FleetShipCount
		,flt.FleetSourceName
		,flt.FleetDestinationSystem
		,flt.FleetDestinationBody
		,flt.FleetDestinationName
		,substr(flt.FleetNameRem,1,flt.SpaceIndex-1) as Cargo
		,substr(flt.FleetNameRem,flt.SpaceIndex+1,flt.SlashIndex-flt.SpaceIndex-1) as Rate	
		,flt.FleetName
		,flt.RaceID
		,flt.FleetID
		--,flt.*	'confac'
	FROM
	(
		SELECT x.FleetType ,x.FleetDesignator, x.FleetShipCount, FleetSourceName, FleetDestinationSystem, FleetDestinationBody, FleetDestinationSystem || FleetDestinationBody as FleetDestinationName, FleetNameRem
			,instr(x.FleetNameRem,' ') as SpaceIndex
			,instr(x.FleetNameRem,'/') as SlashIndex			
			,flt.*
		from FCT_Fleet as flt inner JOIN
		(
			SELECT x.FleetType ,x.FleetDesignator, x.FleetShipCount, x.FleetSourceName--, x.FleetNameRem
				,substr(x.FleetNameRem,1,3) as FleetDestinationSystem
				,substr(x.FleetNameRem,4,instr(x.FleetNameRem,' ')-4) as FleetDestinationBody
				,substr(x.FleetNameRem,instr(x.FleetNameRem,' ')+1) as FleetNameRem
				,flt.*
			from FCT_Fleet as flt inner JOIN
			(
				SELECT x.FleetType ,x.FleetDesignator, x.FleetShipCount--, x.FleetNameRem
					,substr(x.FleetNameRem,1,instr(x.FleetNameRem,' ')-1) as FleetSourceName
					,substr(x.FleetNameRem,instr(x.FleetNameRem,' ')+1) as FleetNameRem
					,flt.*
				from FCT_Fleet as flt inner JOIN
				(
					SELECT x.FleetType ,x.FleetDesignator
						,substr(x.FleetNameRem, 1, instr(x.FleetNameRem,' ')-1) as FleetShipCount
						,substr(x.FleetNameRem,instr(x.FleetNameRem,' ')+1) as FleetNameRem
						,flt.*
					FROM FCT_Fleet as flt inner JOIN
					(
						select x.FleetType, flt.FleetID
							,substr(x.FleetNameRem, 1, instr(x.FleetNameRem,' ')-1) as FleetDesignator
							,substr(x.FleetNameRem,instr(x.FleetNameRem,' ')+1) as FleetNameRem
							
						from FCT_Fleet as flt inner JOIN
						(
							SELECT
								flt.FleetID
								,substr(flt.FleetName,1,instr(flt.FleetName,' ')-1) as FleetType
								,substr(flt.FleetName,instr(flt.FleetName,' ')+1) as FleetNameRem
							from
								FCT_Fleet as flt
							inner JOIN	(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace on CurrentRace.RaceID = flt.RaceID
							WHERE
								substr(flt.FleetName,1,instr(flt.FleetName,' ')-1) in ('CS','FT','TK')
							AND
								flt.FleetName like '%/yr%'
							AND
								flt.ShippingLine = 0
						) as x on x.FleetID = flt.FleetID
					) as x on x.FleetID = flt.FleetID
				) as x on x.FleetID = flt.FleetID
			) as x on x.FleetID = flt.FleetID
		) as x on x.FleetID = flt.FleetID					
	) as flt
) as flt
inner JOIN
	(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace
on
	CurrentRace.RaceID = flt.RaceID
left JOIN
	FCT_MoveOrders as mo_load
on
	mo_load.FleetID = flt.FleetID
AND
	mo_load.MoveActionID in (4,176)
left JOIN
	FCT_MoveOrders as mo_unload
on
	mo_unload.FleetID = flt.FleetID
AND
	mo_unload.MoveActionID in (6,96)
left JOIN
	DIM_PlanetaryInstallation as pi
on
	pi.PlanetaryInstallationID = mo_load.DestinationItemID
inner JOIN
(
	SELECT
		s.FleetID
		,substr(sc.ClassName||' ',1,instr(sc.ClassName||' ',' ')-1) || ifnull(scTrailer.ClassName,'') as ClassName
		--,sc.ClassName || ifnull(scTrailer.ClassName,'') as ClassName --,sc.ClassName || ' ' as ClassName
		,sum(ifnull(sCap.CargoCapacity,0) + ifnull(sCapTrailer.CargoCapacity,0)) as CargoCapacity
		,sCapTanker.*
		--,sdc.*
	FROM
		fct_ship as s
	inner JOIN
		(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace
	on
		CurrentRace.RaceID = s.RaceID
	inner join FCT_ShipClass as sc on sc.ShipClassID = s.ShipClassID
	left join CTE_ShipClassCargoCapacity as sCap on sCap.ShipClassID = s.ShipClassID
	left join fct_ship as sTrailer on sTrailer.ShipID = s.TractorTargetShipID
	left join FCT_ShipClass as scTrailer on scTrailer.ShipClassID = sTrailer.ShipClassID
	left join CTE_ShipClassCargoCapacity as sCapTrailer on sCapTrailer.ShipClassID = sTrailer.ShipClassID
	
	left join CTE_TankerClassMuleCapacity as sCapTanker on sCapTanker.ShipClassID = s.ShipClassID
	/*inner JOIN
		FCT_ClassComponent as cc
	on
		cc.ClassID = s.ShipClassID
	left JOIN
		FCT_ShipDesignComponents as sdc
	on
		sdc.SDComponentID = cc.ComponentID
	AND
		sdc.ComponentTypeID in (4,17)
	left JOIN
		FCT_ShipClass as scTrailer
	on
		scTrailer.ShipClassID = sTrailer.ShipClassID
	left JOIN
		FCT_ClassComponent as ccTrailer
	on
		ccTrailer.ClassID = sTrailer.ShipClassID
	left JOIN
		FCT_ShipDesignComponents as sdcTrailer
	on
		sdcTrailer.SDComponentID = ccTrailer.ComponentID
	AND
		sdcTrailer.ComponentTypeID in (4,17)
	*/
	WHERE
		sc.MaxSpeed > 1 --to avoid double counting trailers: they only appear in the scTrailer join trail		
	group by
		s.FleetID
		,substr(sc.ClassName,1,instr(sc.ClassName,' ')-1) || ifnull(scTrailer.ClassName,'')
) as FleetCapacity
on
	FleetCapacity.FleetID = flt.FleetID

order by
	flt.FleetName;
DROP VIEW IF EXISTS "vw_GovernorSectorBonus";
CREATE VIEW vw_GovernorSectorBonus as 


WITH const AS 
	(select max(RaceID) as RaceID from FCT_Race where NPR = 0)

,CTE_CivilianAdministratorBonus as
(
	SELECT
		cdr.CommanderID
		,cdr.Name
		,cdr.CommandType
		,cdr.PopLocationID
		,1 + sum(CASE WHEN cdrbon.BonusID = 4	THEN cdrbon.BonusValue - 1 ELSE 0 END) as Bonus_Shipbuilding
		,1 + sum(CASE WHEN cdrbon.BonusID = 5	THEN cdrbon.BonusValue - 1 ELSE 0 END) as Bonus_Production
		,1 + sum(CASE WHEN cdrbon.BonusID = 6	THEN cdrbon.BonusValue - 1 ELSE 0 END) as Bonus_Mining
		,1 + sum(CASE WHEN cdrbon.BonusID = 8	THEN cdrbon.BonusValue - 1 ELSE 0 END) as Bonus_PopulationGrowth
		,1 + sum(CASE WHEN cdrbon.BonusID = 9	THEN cdrbon.BonusValue - 1 ELSE 0 END) as Bonus_Terraforming
		,1 + sum(CASE WHEN cdrbon.BonusID = 11	THEN cdrbon.BonusValue - 1 ELSE 0 END) as Bonus_GroundConstruction
		,1 + sum(CASE WHEN cdrbon.BonusID = 14	THEN cdrbon.BonusValue - 1 ELSE 0 END) as Bonus_PoliticalReliability
		,1 + sum(CASE WHEN cdrbon.BonusID = 20	THEN cdrbon.BonusValue - 1 ELSE 0 END) as Bonus_WealthCreation
		,1 + sum(CASE WHEN cdrbon.BonusID = 24	THEN cdrbon.BonusValue - 1 ELSE 0 END) as Bonus_Logistics
	FROM
		FCT_Commander as cdr		
	inner JOIN
		FCT_CommanderBonuses as cdrbon
	on
		cdrbon.CommanderID = cdr.CommanderID
	WHERE
		cdr.CommanderType = 2 --civilian admin
	AND
		cdr.CommandType = 3 --governor
	group by
		cdr.CommanderID
		
	UNION ALL
	
	SELECT
		cdr.CommanderID
		,cdr.Name
		,cdr.CommandType
		,cdr.PopLocationID
		,1 + sum(CASE WHEN cdrbon.BonusID = 4	THEN 0.25 * (cdrbon.BonusValue - 1) ELSE 0 END) as Bonus_Shipbuilding
		,1 + sum(CASE WHEN cdrbon.BonusID = 5	THEN 0.25 * (cdrbon.BonusValue - 1) ELSE 0 END) as Bonus_Production
		,1 + sum(CASE WHEN cdrbon.BonusID = 6	THEN 0.25 * (cdrbon.BonusValue - 1) ELSE 0 END) as Bonus_Mining
		,1 + sum(CASE WHEN cdrbon.BonusID = 8	THEN 0.25 * (cdrbon.BonusValue - 1) ELSE 0 END) as Bonus_PopulationGrowth
		,1 + sum(CASE WHEN cdrbon.BonusID = 9	THEN 0.25 * (cdrbon.BonusValue - 1) ELSE 0 END) as Bonus_Terraforming
		,1 + sum(CASE WHEN cdrbon.BonusID = 11	THEN 0.25 * (cdrbon.BonusValue - 1) ELSE 0 END) as Bonus_GroundConstruction
		,1 + sum(CASE WHEN cdrbon.BonusID = 14	THEN 0.25 * (cdrbon.BonusValue - 1) ELSE 0 END) as Bonus_PoliticalReliability
		,1 + sum(CASE WHEN cdrbon.BonusID = 20	THEN 0.25 * (cdrbon.BonusValue - 1) ELSE 0 END) as Bonus_WealthCreation
		,1 + sum(CASE WHEN cdrbon.BonusID = 24	THEN 0.25 * (cdrbon.BonusValue - 1) ELSE 0 END) as Bonus_Logistics
		--,*
	FROM
		FCT_Commander as cdr
	inner JOIN
		FCT_CommanderBonuses as cdrbon
	on
		cdrbon.CommanderID = cdr.CommanderID
	WHERE
		cdr.CommanderType = 2 --civilian admin
	AND
		cdr.CommandType = 4 --sector	
	group by
		cdr.CommanderID
)

--select * from CTE_CivilianAdministratorBonus


SELECT
	_pop.PopulationID
	,IfNull(cteGov.Bonus_Shipbuilding			,1) * IfNull(cteSec.Bonus_Shipbuilding			,1) as NetBonus_Shipbuilding		
	,IfNull(cteGov.Bonus_Production             ,1) * IfNull(cteSec.Bonus_Production            ,1) as NetBonus_Production           
	,IfNull(cteGov.Bonus_Mining                 ,1) * IfNull(cteSec.Bonus_Mining                ,1) as NetBonus_Mining               
	,IfNull(cteGov.Bonus_PopulationGrowth       ,1) * IfNull(cteSec.Bonus_PopulationGrowth      ,1) as NetBonus_PopulationGrowth     
	,IfNull(cteGov.Bonus_Terraforming           ,1) * IfNull(cteSec.Bonus_Terraforming          ,1) as NetBonus_Terraforming         
	,IfNull(cteGov.Bonus_GroundConstruction     ,1) * IfNull(cteSec.Bonus_GroundConstruction    ,1) as NetBonus_GroundConstruction   
	,IfNull(cteGov.Bonus_PoliticalReliability   ,1) * IfNull(cteSec.Bonus_PoliticalReliability  ,1) as NetBonus_PoliticalReliability 
	,IfNull(cteGov.Bonus_WealthCreation         ,1) * IfNull(cteSec.Bonus_WealthCreation        ,1) as NetBonus_WealthCreation       
	,IfNull(cteGov.Bonus_Logistics              ,1) * IfNull(cteSec.Bonus_Logistics             ,1) as NetBonus_Logistics 
	,cteGov.*
	,cteSec.*

FROM
	FCT_Population as _pop
inner JOIN
	const as c on c.RaceID = _pop.RaceID
left JOIN
	CTE_CivilianAdministratorBonus as cteGov
on
	cteGov.PopLocationID = _pop.PopulationID
AND
	cteGov.CommandType = 3
left JOIN
	FCT_RaceSysSurvey as _rss
on
	_rss.RaceID = c.RaceID
AND
	_rss.SystemID = _pop.SystemID
left JOIN
	FCT_SectorCommand as _seccom
on
	_seccom.SectorCommandID = _rss.SectorID
left JOIN
	CTE_CivilianAdministratorBonus as cteSec
on
	cteSec.PopLocationID = _seccom.PopulationID
AND
	cteSec.CommandType = 4
	

ORDER BY _pop.PopulationID;
DROP VIEW IF EXISTS "vw_empireMining";
CREATE VIEW vw_empireMining as

          select  'Duranium' as Mineral, sum(_pop.Duranium) as Stock, sum(_pop.Duranium) - sum(_pop.LastDuranium) as Change	FROM FCT_Population as _pop inner JOIN (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace on CurrentRace.RaceID = _pop.RaceID
union all select  'Neutronium' as Mineral, sum(_pop.Neutronium) as Stock, sum(_pop.Neutronium) - sum(_pop.LastNeutronium) as Change	FROM FCT_Population as _pop inner JOIN (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace on CurrentRace.RaceID = _pop.RaceID
union all select  'Corbomite' as Mineral, sum(_pop.Corbomite) as Stock, sum(_pop.Corbomite) - sum(_pop.LastCorbomite) as Change	FROM FCT_Population as _pop inner JOIN (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace on CurrentRace.RaceID = _pop.RaceID
union all select  'Tritanium' as Mineral, sum(_pop.Tritanium) as Stock, sum(_pop.Tritanium) - sum(_pop.LastTritanium) as Change	FROM FCT_Population as _pop inner JOIN (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace on CurrentRace.RaceID = _pop.RaceID
union all select  'Boronide' as Mineral, sum(_pop.Boronide) as Stock, sum(_pop.Boronide) - sum(_pop.LastBoronide) as Change	FROM FCT_Population as _pop inner JOIN (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace on CurrentRace.RaceID = _pop.RaceID
union all select  'Mercassium' as Mineral, sum(_pop.Mercassium) as Stock, sum(_pop.Mercassium) - sum(_pop.LastMercassium) as Change	FROM FCT_Population as _pop inner JOIN (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace on CurrentRace.RaceID = _pop.RaceID
union all select  'Vendarite' as Mineral, sum(_pop.Vendarite) as Stock, sum(_pop.Vendarite) - sum(_pop.LastVendarite) as Change	FROM FCT_Population as _pop inner JOIN (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace on CurrentRace.RaceID = _pop.RaceID
union all select  'Sorium' as Mineral, sum(_pop.Sorium) as Stock, sum(_pop.Sorium) - sum(_pop.LastSorium) as Change	FROM FCT_Population as _pop inner JOIN (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace on CurrentRace.RaceID = _pop.RaceID
union all select  'Uridium' as Mineral, sum(_pop.Uridium) as Stock, sum(_pop.Uridium) - sum(_pop.LastUridium) as Change	FROM FCT_Population as _pop inner JOIN (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace on CurrentRace.RaceID = _pop.RaceID
union all select  'Corundium' as Mineral, sum(_pop.Corundium) as Stock, sum(_pop.Corundium) - sum(_pop.LastCorundium) as Change	FROM FCT_Population as _pop inner JOIN (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace on CurrentRace.RaceID = _pop.RaceID
union all select  'Gallicite' as Mineral, sum(_pop.Gallicite) as Stock, sum(_pop.Gallicite) - sum(_pop.LastGallicite) as Change	FROM FCT_Population as _pop inner JOIN (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace on CurrentRace.RaceID = _pop.RaceID;
DROP VIEW IF EXISTS "vw_gamedate";
CREATE VIEW vw_gamedate as
SELECT DATEtime('2025-01-01', '+' || cast(g.GameTime/60/60/24 as varchar) || ' DAY') as GameDate FROM fct_game as g order by g.GameID desc limit 1;
DROP VIEW IF EXISTS "vw_groundsurvey";
CREATE VIEW vw_groundsurvey as 

with CTE_const as (	select (select max(GameID)from FCT_Game ) as GameID, (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as raceID)

SELECT
	upper(substr(sys.Name,1,3)) as Sys
	,upper(substr(sys.Name,1,3))
		|| '-' 
		|| 
		CASE 
			WHEN str.Component = 1 then 'A'
			WHEN str.Component = 2 then 'B'	
			WHEN str.Component = 3 then 'C'	
			WHEN str.Component = 4 then 'D'	
			WHEN str.Component = 5 then 'E'	
			WHEN str.Component = 6 then 'F'
			ELSE 'ZZZZZZZ'
		END	
		||
		CASE 
			WHEN sb.BodyTypeID = 1 THEN 'Ast' || sb.OrbitNumber
			WHEN sb.BodyTypeID = 14 THEN 'Com' || sb.OrbitNumber
			WHEN sb.ParentBodyType = 0 then (sb.PlanetNumber)			
			ELSE (sb.PlanetNumber || 'M' || sb.OrbitNumber)
		END 	
	as BasicName
	,pop.PopName
	,sb.GroundMineralSurvey as Quality
	,sb.Radius / 10 - ifnull(pop.GroundGeoSurvey,0) as GeoPointsRemaining
	,ifnull(form.UnitCount,0) as UnitCount
	,ifnull(form.GeoPointsPerDay*game.SurveySpeed/100,0) as GeoPointsPerDay
	,case when sb.GroundMineralSurvey = 0 then 0 else ifnull((sb.Radius / 10 - pop.GroundGeoSurvey)/form.GeoPointsPerDay/game.SurveySpeed*100,0) end as DaysRemaining
FROM
	FCT_SystemBodySurveys as sbs
inner join CTE_const as x on x.raceID = sbs.RaceID
inner join FCT_SystemBody as sb on sb.SystemBodyID = sbs.SystemBodyID
inner JOIN FCT_RaceSysSurvey as sys on sys.RaceID = x.raceID and sys.SystemID = sb.SystemID
left join FCT_Population as pop on pop.SystemBodyID = sb.SystemBodyID and pop.RaceID = x.raceID
inner join FCT_Game as game on game.GameID = x.GameID
--inner JOIN (select GameID, max(RaceID) as RaceID from FCT_Race where NPR = 0 group by GameID) as CurrentRace on	CurrentRace.RaceID = pop.RaceID and CurrentRace.GameID = game.GameID
left JOIN
	FCT_SystemBody as sb_parent
on
	sb_parent.SystemBodyID = sb.ParentBodyID
inner JOIN
	FCT_Star as str
on
	str.StarID = ifnull(sb_parent.ParentBodyID,sb.ParentBodyID)
or
(
	 --special case for Sol
	 --default bodies in Sol (i.e. not Minerva) have a ParentBodyID of 0
	 --since we know that Sol is a single-star system, we can just take the star that matches the SystemID
	ifnull(sb_parent.ParentBodyID,sb.ParentBodyID) = 0
	AND
	str.SystemID = sys.SystemID
)
left join 
(
	select
		form.PopulationID
		,sum(formelem.Units) as UnitCount
		,sum(class.GeoPointsPerDay*formelem.Units*ifnull(bon.BonusValue,1)) as GeoPointsPerDay
		
	from
		FCT_GroundUnitFormation as form 
	inner join 
		FCT_GroundUnitFormationElement as formelem 
	on 
		form.FormationID = formelem.FormationID
	inner JOIN
	(
		select
			class.GroundUnitClassID
			,case when class.ComponentA = 26 then 0.1 else 0 end 
			+ case when class.ComponentB = 26 then 0.1 else 0 end 
			+ case when class.ComponentC = 26 then 0.1 else 0 end 
			as GeoPointsPerDay
		from FCT_GroundUnitClass as class
		WHERE
		(
			class.ComponentA = 26 or
			class.ComponentB = 26 or
			class.ComponentC = 26
		)
	) as class on formelem.ClassID = class.GroundUnitClassID
	left JOIN
		FCT_Commander as cdr
	on
		cdr.CommandID = form.FormationID
	left JOIN
		FCT_CommanderBonuses as bon
	on
		bon.CommanderID = cdr.CommanderID
	AND
		bon.BonusID = 2
	group by
		form.PopulationID	
) as form
 on pop.PopulationID = form.PopulationID
 WHERE
	sb.GroundMineralSurvey > 0 --and pop.GroundGeoSurvey > 0
or
	ifnull (form.GeoPointsPerDay,0) > 0
order by
	sb.GroundMineralSurvey desc, pop.PopName;
DROP VIEW IF EXISTS "vw_haulingCapacity";
CREATE VIEW vw_haulingCapacity as

WITH const AS (SELECT
	 --'Duffel'
	 --'Slurp'
	 --'HaulerA2' 	 
	 --'Gater'
	 --'Uber'
	-- as designName
	--,
	(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as raceID
	--,2 as minimumComponentCost
)

,CTE_CurrentShipCounts as
(
	SELECT
		s.ShipClassID, count(*) as CurrentCount
	FROM
		FCT_Ship as s
	inner JOIN const on	const.raceID = s.RaceID
	group by s.ShipClassID
		
)

--select * from CTE_CurrentShipCounts

,CTE_ShipClass_ProperCargo as
(
	SELECT
		sc.ClassName
		,sc.ClassShippingLineID
		,counts.CurrentCount --sc.TotalNumber
		,sc.CargoCapacity
		,sc.ColonistCapacity
		,sc.MaxSpeed
		,sc.MaxSpeed * 60.0*60*24*365/1000/1000/1000 as BkmPerYear
		,sc.FuelEfficiency * sc.EnginePower * 24 * 365/1000/1000 * sc.TotalNumber as MLPerYear		
		--,sc.*
	FROM
		FCT_ShipClass as sc
	inner JOIN
		const 
	on
		const.raceID = sc.RaceID
	inner JOIN
		FCT_HullDescription as hd
	on
		hd.HullDescriptionID = sc.HullDescriptionID
	inner join CTE_CurrentShipCounts as counts on counts.ShipClassID = sc.ShipClassID
	WHERE
		(sc.CargoCapacity > 0 or sc.ColonistCapacity > 0)
	AND
		sc.MaxSpeed > 1
	AND
		hd.HullAbbr in ('FT','CS')
	--AND
	--	sc.ClassShippingLineID = 0	
)

,CTE_ShipClass_Trailer as
(
	SELECT
		sc.ClassName
		--,substr(sc.ClassName,1,instr(sc.ClassName,' ')-1) as BaseClassName
		,sc.Size
		,counts.CurrentCount --sc.TotalNumber
		,sc.CargoCapacity
		,sc.ColonistCapacity
		,sc.MaxSpeed
		,hd.HullAbbr
		,sc.ShipClassID
		--,sc.*
	FROM
		FCT_ShipClass as sc
	inner JOIN
		const 
	on
		const.raceID = sc.RaceID
	inner join CTE_CurrentShipCounts as counts on counts.ShipClassID = sc.ShipClassID
	inner JOIN
		FCT_HullDescription as hd
	on
		hd.HullDescriptionID = sc.HullDescriptionID

	WHERE
		(sc.CargoCapacity > 0 or sc.ColonistCapacity > 0)
	AND
		sc.MaxSpeed = 1
	AND
		hd.HullAbbr in ('FT','CS')
	AND
		sc.ClassShippingLineID = 0	
)

--select * from CTE_ShipClass_Trailer

,CTE_ShipClass_Tractor as
(
	SELECT
		sc.ClassName
		,CASE when instr(sc.ClassName,' ') = 0 then sc.ClassName else substr(sc.ClassName,1,instr(sc.ClassName,' ')-1) end as BaseClassName
		,sc.Size
		,counts.CurrentCount --sc.TotalNumber
		,sc.CargoCapacity
		,sc.ColonistCapacity
		,sc.MaxSpeed
		,sc.FuelEfficiency * sc.EnginePower * 24 * 365/1000/1000 * counts.CurrentCount as MLPerYear
		,hd.HullAbbr
		,sc.ShipClassID
		,sc.FuelEfficiency,sc.EnginePower,sc.TotalNumber
		--,sc.*
	FROM
		FCT_ShipClass as sc
	inner JOIN
		const 
	on
		const.raceID = sc.RaceID
	inner join CTE_CurrentShipCounts as counts on counts.ShipClassID = sc.ShipClassID
	inner JOIN
		FCT_HullDescription as hd
	on
		hd.HullDescriptionID = sc.HullDescriptionID
	WHERE
		(sc.CargoCapacity = 0 and sc.ColonistCapacity = 0)
	AND
		sc.MaxSpeed > 1
	AND
		hd.HullAbbr in ('FT','CS','TG','TGL')
	AND
		sc.ClassShippingLineID = 0	
)

--select * from CTE_ShipClass_Tractor

,CTE_ShipClass_TractorTrailer as
(
	SELECT
		ifnull(tract.BaseClassName,tract.ClassName) || trail.ClassName as ClassName
		,0 as ClassShippingLineID
		,combocounts.CurrentCount
		,trail.CargoCapacity
		,trail.ColonistCapacity
		,tract.MaxSpeed * tract.Size / (tract.Size + trail.Size) as MaxSpeed
		,tract.MaxSpeed * tract.Size / (tract.Size + trail.Size) * 60*60*24*365/1000/1000/1000 as BkmPerYear		
		,tract.MLPerYear * combocounts.CurrentCount / tract.CurrentCount as MLPerYear
		
		--,tract.ClassName
		--,tract.FuelEfficiency , tract.EnginePower --* 24 * 365/1000/1000 
		--,tract.TotalNumber
		--,tract.Size
		--,trail.ClassName
		--,trail.Size
		--,tract.TotalNumber as Tractors
		--,trail.TotalNumber as Trailers
		
	FROM		
	(
		SELECT
			tract.ShipClassID as tractorClassID ,trail.ShipClassID as trailerClassID
			--,trail.ClassName as trailClassName
			,count(*) as CurrentCount
		from
			fct_ship as shp 
		inner JOIN const on const.raceID = shp.RaceID
		inner join CTE_ShipClass_Tractor as tract on tract.ShipClassID = shp.ShipClassID
		inner join fct_ship as shp_trailer on shp_trailer.ShipID = shp.TractorTargetShipID
		inner JOIN CTE_ShipClass_Trailer as trail on trail.ShipClassID = shp_trailer.ShipClassID
		group by tract.ShipClassID,trail.ShipClassID
	) as combocounts
	inner join CTE_ShipClass_Tractor as tract on tract.ShipClassID = combocounts.tractorClassID
	inner join CTE_ShipClass_Trailer as trail on trail.ShipClassID = combocounts.trailerClassID
	
)
--select * from CTE_ShipClass_TractorTrailer


SELECT * FROM 
(
select 
	*
	, sc.CargoCapacity/25000 * sc.BkmPerYear * sc.CurrentCount as CargoHoldBKMPerYear
	, sc.ColonistCapacity * sc.MaxSpeed * 60.0*60*24*365/1000/1000/1000/1000/1000 * sc.CurrentCount as MPopBKMPerYear
from CTE_ShipClass_ProperCargo as sc
union ALL
select
	*
	, sc.CargoCapacity/25000 * sc.BkmPerYear * sc.CurrentCount as CargoHoldBKMPerYear
	, sc.ColonistCapacity * sc.MaxSpeed * 60.0*60*24*365/1000/1000/1000/1000/1000 * sc.CurrentCount as MPopBKMPerYear
from CTE_ShipClass_TractorTrailer as sc
) as x order by x.ClassShippingLineID, x.ClassName;
DROP VIEW IF EXISTS "vw_industrialProjects";
CREATE VIEW vw_industrialProjects as 

WITH const AS (SELECT
	(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as raceID
),

CTE_ProductionTypes as
(
				select 0 as ProductionType, 'installations' as ProductionTypeName	,'confac' as ProductionFacility
	union all 	select 1 as ProductionType, 'ordnance' as ProductionTypeName		,'ordfac' as ProductionFacility
	union all 	select 2 as ProductionType, 'fighter' as ProductionTypeName			,'ftrfac' as ProductionFacility
	union all 	select 3 as ProductionType, 'ship components' as ProductionTypeName	,'confac' as ProductionFacility
	union all 	select 4 as ProductionType, 'space station' as ProductionTypeName	,'confac' as ProductionFacility
),

CTE_PopulationProductionCapacity as 
(
	select
		p.PopulationID
		,sum(gsb.NetBonus_Production * pi.amount * r.ConstructionProduction * dpi.ConstructionValue) as ConstructionRate
		,sum(gsb.NetBonus_Production * pi.amount * r.FighterProduction * dpi.FighterProductionValue) as FighterProductionRate
		,sum(gsb.NetBonus_Production * pi.amount * r.OrdnanceProduction * dpi.OrdnanceProductionValue) as OrdnanceProductionRate		
	FROM
		const as c
	inner JOIN
		FCT_Race as r
	on
		r.RaceID = c.RaceID
	inner JOIN
		FCT_Population as p
	on
		p.RaceID = r.RaceID
	inner JOIN
		FCT_PopulationInstallations as pi
	on
		pi.PopID = p.PopulationID
	inner JOIN
		DIM_PlanetaryInstallation as dpi
	on
		dpi.PlanetaryInstallationID = pi.PlanetaryInstallationID
	inner JOIN
		vw_GovernorSectorBonus as gsb
	on
		gsb.PopulationID = p.PopulationID
	group by
		p.PopulationID
	--TODO: governor/sector bonuses
	--TODO: population efficiency modifiers (political, worker shortage, etc)
	
)


--surface production
SELECT
	vp.PopulationID
	,vp.PopName
	,vp.BasicPopName
	,ip.ProductionType --0=installations, 1=ordnance, 2=fighter, 3=???ship components???, 4=space station
	,cpt.ProductionFacility
	,IFNULL(cpt.ProductionTypeName,'UNKNOWN') as ProductionTypeName
	,ip.Description
	,ip.Percentage
	,365 * ip.BP / (ip.Percentage/100) / CASE
		when ip.ProductionType in (0,3,4) then ppc.ConstructionRate
		when ip.ProductionType in (1) then ppc.OrdnanceProductionRate
		when ip.ProductionType in (2) then ppc.FighterProductionRate
		else 0
	END as CompletionDays
	,ip.Queue
	,ip.BP
	,ip.Duranium
	,ip.Neutronium
	,ip.Corbomite
	,ip.Tritanium
	,ip.Boronide
	,ip.Mercassium
	,ip.Vendarite
	,ip.Sorium
	,ip.Uridium
	,ip.Corundium
	,ip.Gallicite
	--,ip.*
FROM
	const as c
/*
inner JOIN
	FCT_Race as r
on
	r.RaceID = c.RaceID
*/
inner JOIN
	FCT_Population as p
on
	p.RaceID =c.RaceID
left JOIN
	vw_popname as vp
on
	vp.PopulationID = p.PopulationID
inner JOIN
(
	SELECT
		ip.PopulationID
		,ip.ProductionType
		,ip.Description
		,ip.Percentage
		,ip.Queue
		,ip.Amount * ProdPerUnit as BP
		,ip.Amount * ip.Duranium as Duranium
		,ip.Amount * ip.Neutronium as Neutronium
		,ip.Amount * ip.Corbomite as Corbomite
		,ip.Amount * ip.Tritanium as Tritanium
		,ip.Amount * ip.Boronide as Boronide
		,ip.Amount * ip.Mercassium as Mercassium
		,ip.Amount * ip.Vendarite as Vendarite
		,ip.Amount * ip.Sorium as Sorium
		,ip.Amount * ip.Uridium as Uridium
		,ip.Amount * ip.Corundium as Corundium
		,ip.Amount * ip.Gallicite as Gallicite
	from
		FCT_IndustrialProjects as ip
	where ip.Pause = 0
) as ip
on
	ip.PopulationID = p.PopulationID
/*
inner JOIN
	FCT_PopulationInstallations as pi
on
	pi.PopulationID = p.PopulationID
AND
	pi.PlanetaryInstallationID = CASE
		when ip.ProductionType = 0 then 
*/
inner JOIN
	CTE_PopulationProductionCapacity as ppc
on
	ppc.PopulationID = p.PopulationID
left JOIN
	CTE_ProductionTypes as cpt
on
	cpt.ProductionType = ip.ProductionType
	
order by cpt.ProductionType desc

--ShipBuilding

--shiprepair

--shiprefit

--shipyard mods

--ground units;
DROP VIEW IF EXISTS "vw_mineralStocks";
CREATE VIEW vw_mineralStocks as

SELECT
	upper(substr(_rss.Name,1,3)) as Sys
	,_pop.PopName as BodyName
	,_pop.Duranium as Dur
	,_pop.Neutronium as Neu
	,_pop.Corbomite as Crb
	,_pop.Tritanium as Tri
	,_pop.Boronide as Bor
	,_pop.Mercassium as Mer
	,_pop.Vendarite as Ven
	,_pop.Sorium as Sor
	,_pop.Uridium as Uri
	,_pop.Corundium as Crn
	,_pop.Gallicite as Gal
	,_pop.PopulationID
			
		
		/*
		,_pop.PopName as BodyName
		,CASE when dpi.Name = 'Civilian Mining Complex' and _pop.PurchaseCivilianMinerals = 0 then 0 else 1 end as IsOwned
		,fm.MaterialID
		,fm.Amount
		,fm.Accessibility
		,fm.HalfOriginalAmount
		,fm.OriginalAcc
		,_pgov.Name as Governor
		,dpi.Name as MineType
		,_race.MineProduction
		,_pi.Amount * CASE WHEN _pi.PlanetaryInstallationID = 39 THEN 10 else 1 end as MineCount
		--,_pgov.CommandType --4 = sector, 3 = governor
		,_pgov.Name as Governor
		,ifnull(_pgovbon.BonusValue,1.0) as GovBonus
		,_sgov.Name as SectorLeader
		,ifnull(1+(_sgovbon.BonusValue-1)/4,1.0) as SectorBonus
		*/		
		--select *
	FROM
		FCT_Population as _pop
	inner JOIN
		(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace
	on
		CurrentRace.RaceID = _pop.RaceID
	left JOIN
		FCT_RaceSysSurvey as _rss
	on
		_rss.RaceID = _pop.RaceID
	AND
		_rss.SystemID = _pop.SystemID
--	group by
--		_pop.SystemID
	
		
/*
	inner JOIN
		FCT_Race as _race
	on
		_race.RaceID = _pop.RaceID
	inner JOIN
		FCT_SystemBody as sysbod
	on
		sysbod.SystemBodyID = _pop.SystemBodyID
	left join
		FCT_MineralDeposit as fm
	on
		fm.SystemBodyID = _pop.SystemBodyID	
	left JOIN
		FCT_PopulationInstallations as _pi
	on
		_pi.PopID = _pop.PopulationID
	left JOIN
		DIM_PlanetaryInstallation as dpi
	on
		dpi.PlanetaryInstallationID = _pi.PlanetaryInstallationID
	left JOIN
		FCT_Commander as _pgov
	on
		_pgov.PopLocationID = _pop.PopulationID
	AND
		_pgov.CommanderType = 2 --civilian admin
	AND
		_pgov.CommandType = 3 --governor
	left JOIN
		FCT_CommanderBonuses as _pgovbon
	on
		_pgovbon.CommanderID = _pgov.CommanderID
	AND
		_pgovbon.BonusID = 6 --mining bonus
	
	left JOIN
		FCT_SectorCommand as _seccom
	on
		_seccom.SectorCommandID = _rss.SectorID
	left JOIN
		FCT_Commander as _sgov
	on
		_sgov.CommandID = _seccom.SectorCommandID
	AND
		_sgov.CommanderType = 2 --civilian admin
	AND
		_sgov.CommandType = 4 --Sector
	left JOIN
		FCT_CommanderBonuses as _sgovbon
	on
		_sgovbon.CommanderID = _sgov.CommanderID
	AND
		_sgovbon.BonusID = 6 --mining bonus
	WHERE
	(
		dpi.Name in ('Mine','Automated Mine','Civilian Mining Complex')
	AND	
		_pi.Amount > 0
	)
) as surface
order by
	surface.BodyName
	,surface.MaterialID;
DROP VIEW IF EXISTS "vw_popname";
CREATE VIEW vw_popname as 
SELECT
	pop.PopulationID
	,pop.PopName
	--,instr(pop.PopName,' ')
	,CASE
		WHEN instr(pop.PopName,' ') > 0 THEN substr(pop.PopName,1,instr(pop.PopName,' ')-1)
		ELSE pop.PopName
	END as BasicPopName
FROM
	FCT_Population as pop;
DROP VIEW IF EXISTS "vw_supplies";
CREATE VIEW vw_supplies as
select
	_pop.PopName as Pop
	,_pop.FuelStockpile / 1000000 as Fuel
	,case when pi_refuelpoint.PopID is null then 0 else 1 end as RefuelPoint
	,_pop.MaintenanceStockpile / 1000 as MSP
	,case when pi_resupplypoint.PopID is null then 0 else 1 end as ResupplyPoint
	,IFNULL(pi_mfcounts.MFCount,0) as MFCount
	,IFNULL(pop_MilTons.MilTons,0) as MilTons
	--,*
from
	FCT_Population as _pop
inner JOIN
	(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace
on
	CurrentRace.RaceID = _pop.RaceID
left JOIN
(
	select distinct pi.PopID from FCT_PopulationInstallations as pi
	left JOIN DIM_PlanetaryInstallation as dpi
	on dpi.PlanetaryInstallationID = pi.PlanetaryInstallationID
	where dpi.MassRefuelling = 1 and pi.Amount >= 1
) as pi_refuelpoint
on
	pi_refuelpoint.PopID = _pop.PopulationID
left JOIN
(
	select distinct pi.PopID from FCT_PopulationInstallations as pi
	left JOIN DIM_PlanetaryInstallation as dpi
	on dpi.PlanetaryInstallationID = pi.PlanetaryInstallationID
	where dpi.CargoShuttleValue > 0 or dpi.MaintenanceValue > 0
) as pi_resupplypoint
on
	pi_resupplypoint.PopID = _pop.PopulationID
left JOIN
(
	select pi.PopID, pi.Amount as MFCount from FCT_PopulationInstallations as pi
	left JOIN DIM_PlanetaryInstallation as dpi
	on dpi.PlanetaryInstallationID = pi.PlanetaryInstallationID
	where dpi.MaintenanceValue > 0	
) as pi_mfcounts
on
	pi_mfcounts.PopID = _pop.PopulationID
left JOIN
(
select
	flt.AssignedPopulationID as PopID
	,sum(ShipClass.Size)*50 as MilTons
FROM
	FCT_Fleet as flt
inner JOIN
	FCT_Ship as Ship
on
	Ship.FleetID = flt.FleetID
inner JOIN
	FCT_ShipClass as ShipClass
on
	ShipClass.ShipClassID = Ship.ShipClassID
WHERE
	ShipClass.Commercial = 0
AND
	Ship.MothershipID = 0 --ships docked in a hangar do not count towards planetary maintenance limits
group by
	flt.AssignedPopulationID
) as pop_MilTons
on
	pop_MilTons.PopID = _pop.PopulationID
where
	_pop.FuelStockpile > 0
or
	pi_refuelpoint.PopID is not null
or
	_pop.MaintenanceStockpile > 0
or
	pi_resupplypoint.PopID is not null
order by
	_pop.FuelStockpile desc
	,_pop.MaintenanceStockpile desc
	
	
	
--select * from FCT_Population as p where p.PopName like 'cat%'
--select * from FCT_PopulationInstallations where PopID = 4425;
DROP VIEW IF EXISTS "vw_tfplan";
CREATE VIEW vw_tfplan as 


SELECT
	upper(substr(sys.Name,1,3)) as Sys
	,popName.BasicPopName
	,ifnull(pop.PopName,
	upper(substr(sys.Name,1,3))
		|| '-' 
		|| 
		CASE 
			WHEN str.Component = 1 then 'A'
			WHEN str.Component = 2 then 'B'	
			WHEN str.Component = 3 then 'C'	
			WHEN str.Component = 4 then 'D'	
			WHEN str.Component = 5 then 'E'	
			WHEN str.Component = 6 then 'F'	
			ELSE 'ZZZZZZZ'
		END	
		||
		CASE 
			WHEN sb.BodyTypeID = 1 THEN 'Ast' || sb.OrbitNumber
			WHEN sb.BodyTypeID = 14 THEN 'Com' || sb.OrbitNumber
			WHEN sb.ParentBodyType = 0 then (sb.PlanetNumber)			
			ELSE (sb.PlanetNumber || 'M' || sb.OrbitNumber)
		END 
	/*	*/
	)	as MyName
	,sb.Radius * 2 / 1000.0 as DiameterK
	,CASE 
		when surv.SystemBodyID is null 
			then sb.Radius/100.0 * CASE 
				when sb.BodyTypeID in (4,5) then 1
				when sb.BodyTypeID in (14) then 10
				else 10 end 
		else 0 
	end as SurvPts
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Duranium		/1000 ,0) end	as	Duranium
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Neutronium		/1000 ,0) end	as	Neutronium
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Corbomite		/1000 ,0) end	as	Corbomite
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Tritanium		/1000 ,0) end	as	Tritanium
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Boronide		/1000 ,0) end	as	Boronide
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Mercassium		/1000 ,0) end	as	Mercassium
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Vendarite		/1000 ,0) end	as	Vendarite
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Sorium			/1000 ,0) end	as	Sorium
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Uridium		/1000 ,0) end	as	Uridium
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Corundium		/1000 ,0) end	as	Corundium
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Gallicite		/1000 ,0) end	as	Gallicite
	
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.DuraniumAcc	,0) end	as	DuraniumAcc
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.NeutroniumAcc	,0) end	as	NeutroniumAcc
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.CorbomiteAcc	,0) end	as	CorbomiteAcc
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.TritaniumAcc	,0) end	as	TritaniumAcc
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.BoronideAcc	,0) end	as	BoronideAcc
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.MercassiumAcc	,0) end	as	MercassiumAcc
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.VendariteAcc	,0) end	as	VendariteAcc
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.SoriumAcc		,0) end	as	SoriumAcc
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.UridiumAcc		,0) end	as	UridiumAcc
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.CorundiumAcc	,0) end	as	CorundiumAcc
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.GalliciteAcc	,0) end	as	GalliciteAcc

	,CASE when surv.SystemBodyID is null then '' else ifnull(sb_mins.Acc1M,0) end as Acc1mil
	,CASE when surv.SystemBodyID is null then '' else ifnull(sb_mins.Acc100k,0) end as Acc100k
	,CASE when surv.SystemBodyID is null then '' else ifnull(sb_mins.Acc10k,0) end as Acc10k
	,CASE when surv.SystemBodyID is null then '' else ifnull(sb_mins.Acc1k,0) end as Acc1k
	, CASE 
		when pop.SystemBodyID is not null then ifnull(sb_mins.CMCQualified/4.0,0) --CMCs will not appear on established colonies
		else ifnull(sb_mins.CMCQualified,0) end as CMCQualified --0 is not qualified; >= 1 is qualified; in between means would be qualified, but has a colony
	, ifnull(sb_mins.CMCScore,0)/1000000.0 as CMCScore
	,sb.BodyTypeID
	,sb.Gravity
	,sb.HydroExt/100 as Hydro
	,case 	
		WHEN sb.TidalLock = 1 THEN CASE			
			WHEN sb.ParentBodyType = 0 THEN 'Y' --planets, asteroids, comets
			ELSE 'M' --moons
			END		
		ELSE ''
	END as Tlock
	,IFNULL(pop.LastColonyCost, '') as ColCost
	,sb.BaseTemp	--http://aurora2.pentarch.org/index.php?topic=11545.msg169480#msg169480
	,str.Luminosity
	,case 
		WHEN sb.BodyClass = 2 then sb_parent.DistanceToParent --moons
		--WHEN sb.BodyTypeID = 14 then sb.DistanceToParent --comets
		--WHEN sb.BodyTypeID = 1 then sb.DistanceToParent --asteroids
		--WHEN sb.BodyClass = 2 then sb_parent.DistanceToOrbitCentre --moons
		else sb.DistanceToParent end 
		as DistanceToStar
	,sb.Albedo
	,IFNULL(atm_ox.GasAtm,0) as Oxygen
	,IFNULL(atm_GH.GasAtm,0) as GH
	,IFNULL(atm_GHTox.GasAtm,0) as GHTox
	,IFNULL(atm_AGH.GasAtm,0) as AGH
	,IFNULL(atm_tox2.GasAtm,0) as Tox2
	,IFNULL(atm_tox3.GasAtm,0) as Tox3
	,IFNULL(atm_oth.GasAtm,0) as Oth
FROM
(
	select max(RaceID) as RaceID from FCT_Race where NPR = 0
) as Race
inner JOIN
	FCT_RaceSysSurvey as sys
on 
	sys.RaceID = Race.RaceID
inner JOIN
	FCT_SystemBody as sb
on
	sb.SystemID  = sys.SystemID
left JOIN
	FCT_Population as pop
on
	pop.SystemBodyID = sb.SystemBodyID
AND
	pop.RaceID = Race.RaceID
left JOIN
	vw_popname as popname
on
	popname.PopulationID = pop.PopulationID
left JOIN
	FCT_SystemBody as sb_parent
on
	sb_parent.SystemBodyID = sb.ParentBodyID
inner JOIN
	FCT_Star as str
on
	str.StarID = ifnull(sb_parent.ParentBodyID,sb.ParentBodyID)
or
(
	 --special case for Sol
	 --default bodies in Sol (i.e. not Minerva) have a ParentBodyID of 0
	 --since we know that Sol is a single-star system, we can just take the star that matches the SystemID
	ifnull(sb_parent.ParentBodyID,sb.ParentBodyID) = 0
	AND
	str.SystemID = sys.SystemID
)
left JOIN
	FCT_SystemBodySurveys as surv
on
	surv.RaceID = Race.RaceID
AND
	surv.SystemBodyID = sb.SystemBodyID
left JOIN
	FCT_AtmosphericGas as atm_ox
on
	atm_ox.SystemBodyID = sb.SystemBodyID
AND
	atm_ox.AtmosGasID = 10
left JOIN
	FCT_AtmosphericGas as atm_GH
on
	atm_GH.SystemBodyID = sb.SystemBodyID
AND
	atm_GH.AtmosGasID = 20
left JOIN
(
	SELECT
		ag.SystemBodyID
		,sum(ag.GasAtm) as GasAtm
	FROM
		FCT_AtmosphericGas as ag
	where
		ag.AtmosGasID in (3,13,14,15)		
	group by
		ag.SystemBodyID	
) as atm_GHTox
on
	atm_GHTox.SystemBodyID = sb.SystemBodyID
left JOIN
	FCT_AtmosphericGas as atm_AGH
on
	atm_AGH.SystemBodyID = sb.SystemBodyID
AND
	atm_AGH.AtmosGasID = 22
left JOIN
(
	SELECT
		ag.SystemBodyID
		,sum(ag.GasAtm) as GasAtm
	from
		FCT_AtmosphericGas as ag	
	where
		ag.AtmosGasID in (1,3,4,8,9,11,13,14,15,19)
		
	group by
		ag.SystemBodyID
) as atm_tox2
on
	atm_tox2.SystemBodyID = sb.SystemBodyID
left JOIN
(
	SELECT
		ag.SystemBodyID
		,sum(ag.GasAtm) as GasAtm
	from
		FCT_AtmosphericGas as ag	
	where
		ag.AtmosGasID in (16,17,18)
	group by
		ag.SystemBodyID
) as atm_tox3
on
	atm_tox3.SystemBodyID = sb.SystemBodyID
left JOIN
(
	SELECT
		ag.SystemBodyID
		,sum(ag.GasAtm) as GasAtm
	from
		FCT_AtmosphericGas as ag	
	where
		ag.AtmosGasID in (0,2,6,7,12)
	group by
		ag.SystemBodyID
) as atm_oth
on
	atm_oth.SystemBodyID = sb.SystemBodyID
left JOIN
(
	select 
		md.SystemBodyID
		,sum(case when md.MaterialID = 1 then md.Amount else 0 end) as Duranium
		,sum(case when md.MaterialID = 2 then md.Amount else 0 end) as Neutronium
		,sum(case when md.MaterialID = 3 then md.Amount else 0 end) as Corbomite
		,sum(case when md.MaterialID = 4 then md.Amount else 0 end) as Tritanium
		,sum(case when md.MaterialID = 5 then md.Amount else 0 end) as Boronide
		,sum(case when md.MaterialID = 6 then md.Amount else 0 end) as Mercassium
		,sum(case when md.MaterialID = 7 then md.Amount else 0 end) as Vendarite
		,sum(case when md.MaterialID = 8 then md.Amount else 0 end) as Sorium
		,sum(case when md.MaterialID = 9 then md.Amount else 0 end) as Uridium
		,sum(case when md.MaterialID = 10 then md.Amount else 0 end) as Corundium
		,sum(case when md.MaterialID = 11 then md.Amount else 0 end) as Gallicite

		,sum(case when md.MaterialID = 1 then md.Accessibility else 0 end) as DuraniumAcc
		,sum(case when md.MaterialID = 2 then md.Accessibility else 0 end) as NeutroniumAcc
		,sum(case when md.MaterialID = 3 then md.Accessibility else 0 end) as CorbomiteAcc
		,sum(case when md.MaterialID = 4 then md.Accessibility else 0 end) as TritaniumAcc
		,sum(case when md.MaterialID = 5 then md.Accessibility else 0 end) as BoronideAcc
		,sum(case when md.MaterialID = 6 then md.Accessibility else 0 end) as MercassiumAcc
		,sum(case when md.MaterialID = 7 then md.Accessibility else 0 end) as VendariteAcc
		,sum(case when md.MaterialID = 8 then md.Accessibility else 0 end) as SoriumAcc
		,sum(case when md.MaterialID = 9 then md.Accessibility else 0 end) as UridiumAcc
		,sum(case when md.MaterialID = 10 then md.Accessibility else 0 end) as CorundiumAcc
		,sum(case when md.MaterialID = 11 then md.Accessibility else 0 end) as GalliciteAcc

		,sum(case when md.Amount>=1000000 then md.Accessibility else 0 end ) as Acc1M
		,sum(case when md.Amount>=100000 then md.Accessibility else 0 end ) as Acc100k 
		,sum(case when md.Amount>=10000 then md.Accessibility else 0 end ) as Acc10k 
		,sum(case when md.Amount>=1000 then md.Accessibility else 0 end ) as Acc1k 
		,sum(CASE
			WHEN md.MaterialID in (1,11) and md.Amount >= 10000 and md.Accessibility >= 0.7 then 1
			ELSE 0
		END) as CMCQualified
		,sum(CASE
			WHEN md.MaterialID = 1 and md.Accessibility >= 0.5 then md.Amount * 2
			WHEN md.MaterialID <> 1 and md.Accessibility >= 0.5 then md.Amount
			ELSE 0
		END) as CMCScore
	from 
		FCT_MineralDeposit as md 
	group by 
		md.SystemBodyID
) as sb_mins
on
	sb_mins.SystemBodyID = surv.SystemBodyID


	
--order by 1;
DROP VIEW IF EXISTS "vw_jumppoints";
CREATE VIEW vw_jumppoints as 
with CTE_Const as 
(
	select max(RaceID) as RaceID from FCT_Race where NPR = 0
)

SELECT
	upper(substr(rss.Name,1,3)) as Sys
	,upper(substr(rss_dest.Name,1,3)) as Sys_Dest
	,upper(substr(rss.Name,1,3) || '-' || substr(rss_dest.Name,1,3)) as JPName
	,jp.Xcor
	,jp.Ycor
	--,jp.*
	--,jp_dest.*
FROM
	FCT_RaceJumpPointSurvey as rjps
inner join
	CTE_Const
on
	CTE_Const.RaceID = rjps.RaceID
inner JOIN
	FCT_JumpPoint as jp
on
	jp.WarpPointID = rjps.WarpPointID
inner JOIN
	FCT_System as sys
on
	sys.SystemID = jp.SystemID
inner join
	FCT_RaceSysSurvey as rss
on
	rss.SystemID = jp.SystemID
AND
	rss.RaceID = rjps.RaceID
inner JOIN
	FCT_JumpPoint as jp_dest
on
	jp_dest.WarpPointID = jp.WPLink
inner JOIN
	FCT_System as sys_dest
on
	sys_dest.SystemID = jp.SystemID
inner join
	FCT_RaceSysSurvey as rss_dest
on
	rss_dest.SystemID = jp_dest.SystemID
AND
	rss_dest.RaceID = rjps.RaceID

	
	
	
	
	
	
	
	
	
	
	/*	
left JOIN
	FCT_RaceSurveyLocation as rsl
on
	rsl.RaceID = rss.RaceID
AND
	rsl.SystemID = sl.SystemID
AND
	rsl.LocationNumber = sl.LocationNumber
*/
WHERE
	rjps.Explored = 1;
DROP VIEW IF EXISTS "vw_surveylocations";
CREATE VIEW vw_surveylocations as 
with CTE_Const as 
(
	select max(RaceID) as RaceID from FCT_Race where NPR = 0
)

SELECT
	upper(substr(rss.Name,1,3)) as Sys
	,sl.LocationNumber
	,sl.Xcor
	,sl.Ycor
	--,sys.JumpPointSurveyPoints as PtsPerLoc
	--,30-IFNULL(LocationsDone.cnt,0) as UnexLocs	
	--,'' as AssignedFleets
	--,IFNULL(InProgress.cnt,0) as InProgressLocs
	--,IFNULL(InProgress.PointsRemaining,0) as InProgressPointsRemaining
	--,*
FROM
	FCT_SurveyLocation as sl
inner JOIN
	FCT_System as sys
on
	sys.SystemID = sl.SystemID
inner join
	FCT_RaceSysSurvey as rss
on
	rss.SystemID = sl.SystemID
inner join
	CTE_Const
on
	CTE_Const.RaceID = rss.RaceID
left JOIN
	FCT_RaceSurveyLocation as rsl
on
	rsl.RaceID = rss.RaceID
AND
	rsl.SystemID = sl.SystemID
AND
	rsl.LocationNumber = sl.LocationNumber
WHERE
	rsl.LocationNumber is null;
DROP VIEW IF EXISTS "vw_pop";
CREATE VIEW vw_pop as 
SELECT
	_pop.PopName
	,popName.BasicPopName
	,_pop.Population
	,ifnull(InboundShipping.PopAmount/1000/1000,0) as InboundPop
	
	--Inbound Total Amounts
	,ifnull(InboundShipping.MineAmount,0) as InboundMine
	,ifnull(InboundShipping.INFAmount,0) as InboundINF
	,ifnull(InboundShipping.DSTAmount,0) as InboundDST
	,ifnull(InboundShipping.LGIAmount,0) as InboundLGI
	,ifnull(InboundShipping.ConFacAmount		,0) as InboundConFac
	,ifnull(InboundShipping.MaintFacAmount,0) as InboundMaintFac
	,ifnull(InboundShipping.FinCenAmount,0) as InboundFinCen
	,ifnull(InboundShipping.LabAmount,0) as InboundLab
	,ifnull(InboundShipping.TradeGoodsAmount,0) as InboundTG
	,ifnull(InboundShipping.TotalAmount,0.0) - ifnull(InboundShipping.PopAmount,0) - ifnull(InboundShipping.MineAmount,0.0) - ifnull(InboundShipping.INFAmount,0.0)- ifnull(InboundShipping.DSTAmount,0.0) - ifnull(InboundShipping.LGIAmount,0.0) - ifnull(InboundShipping.ConFacAmount,0.0) - ifnull(InboundShipping.MaintFacAmount,0.0) - ifnull(InboundShipping.FinCenAmount,0) - ifnull(InboundShipping.LabAmount,0) - ifnull(InboundShipping.TradeGoodsAmount,0) as InboundOther
	
	--Inbound Cycling Amounts
	,ifnull(InboundCycling.MineAmount,0) as InboundMine_Cycling
	,ifnull(InboundCycling.INFAmount,0) as InboundINF_Cycling
	,ifnull(InboundCycling.DSTAmount,0) as InboundDST_Cycling
	,ifnull(InboundCycling.LGIAmount,0) as InboundLGI_Cycling
	,ifnull(InboundCycling.ConFacAmount		,0) as InboundConFac_Cycling
	,ifnull(InboundCycling.MaintFacAmount,0) as InboundMaintFac_Cycling
	,ifnull(InboundCycling.FinCenAmount,0) as InboundFinCen_Cycling
	,ifnull(InboundCycling.LabAmount,0) as InboundLab_Cycling
	,ifnull(InboundCycling.TotalAmount,0.0) - ifnull(InboundCycling.PopAmount,0) - ifnull(InboundCycling.MineAmount,0.0) - ifnull(InboundCycling.INFAmount,0.0)- ifnull(InboundCycling.DSTAmount,0.0) - ifnull(InboundCycling.LGIAmount,0.0) - ifnull(InboundCycling.ConFacAmount,0.0) - ifnull(InboundCycling.MaintFacAmount,0.0) - ifnull(InboundCycling.FinCenAmount,0) - ifnull(InboundCycling.LabAmount,0) as InboundOther_Cycling
	
	,_pop.ColonistDestination
	,_pop.ReqInf
	,_pop.MaintenanceStockpile
	,_pop.MaintProdStatus
	,_infr.InfraTOTAL
	,_infr.InfraRegular
	,_infr.InfraLG
	,_infr.WorkersRequired_Infr
	,_yard.WorkersRequired_Yard
	,_infr.Confacs
	,_infr.DST
	,_infr.MassDrivers
	,_infr.MFacs
	,_infr.Refineries
	,ifnull(ipInfra.Percentage, 0) as InfraPCT
	,ifnull(ipLGI.Percentage, 0) as LGIPCT
	,ifnull(ipCamps.Percentage, 0) as CampsPCT
	,ifnull(ipConfacs.Percentage, 0) as ConFacsPCT
	,gsb.NetBonus_GroundConstruction
	,gsb.NetBonus_Logistics
	,gsb.NetBonus_Mining
	,gsb.NetBonus_PopulationGrowth
	,gsb.NetBonus_Production
	,gsb.NetBonus_Shipbuilding
	,gsb.NetBonus_Terraforming
	,gsb.NetBonus_WealthCreation
	,ifnull(ShipCosts.TotalShipCost, 0) as TotalShipCost
	,ifnull(ShipCosts.SupplyShipMSPAvailable, 0) as SupplyShipMSPAvailable
	
	
	--,*
FROM
	FCT_Population as _pop
inner JOIN
	(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace
on
	CurrentRace.RaceID = _pop.RaceID
left JOIN vw_popname as popname on popname.PopulationID = _pop.PopulationID
left JOIN
(
	SELECT
		_pi.PopID
		,sum(case when _pi.PlanetaryInstallationID = 9 then _pi.Amount else 0 end) as InfraRegular
		,sum(case when _pi.PlanetaryInstallationID = 41 then _pi.Amount else 0 end) as InfraLG
		,sum(case when _pi.PlanetaryInstallationID in (9,41) then _pi.Amount else 0 end) as InfraTOTAL
		,sum(case when _pi.PlanetaryInstallationID in (5,47) then _pi.Amount else 0 end) as Confacs
		,sum(case when _pi.PlanetaryInstallationID = 11 then _pi.Amount else 0 end) as DST
		,sum(case when _pi.PlanetaryInstallationID = 24 then _pi.Amount else 0 end) as MassDrivers
		,sum(case when _pi.PlanetaryInstallationID = 21 then _pi.Amount else 0 end) as MFacs		
		,sum(case when _pi.PlanetaryInstallationID = 3 then _pi.Amount else 0 end) as Refineries
		,sum(dpi.Workers * _pi.Amount) as WorkersRequired_Infr
	from
		FCT_PopulationInstallations as _pi
	left JOIN
		DIM_PlanetaryInstallation as dpi on dpi.PlanetaryInstallationID = _pi.PlanetaryInstallationID
	group by 
		_pi.PopID 
) as _infr
on
	_infr.PopID = _pop.PopulationID
left JOIN
(
	SELECT
		yard.PopulationID
		,SUM(yard.Capacity * yard.Slipways * CASE yard.SYType WHEN 1 then 1 ELSE 0.1 END) / 1000 / 4 as WorkersRequired_Yard
	FROM
		FCT_Shipyard as yard
	group by yard.PopulationID
) as _yard
on
	_yard.PopulationID = _pop.PopulationID
left JOIN
(
	SELECT
		sum(case when sc.CargoTypeID = 1 then sc.Amount else 0 end) as PopAmount
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 7 then sc.Amount else 0 end) as MineAmount
		,sum(case when (sc.CargoTypeID = 2 and sc.CargoID = 9) or (sc.CargoTypeID = 7 and sc.CargoID = 16) then sc.Amount else 0 end) as INFAmount
		,sum(case when (sc.CargoTypeID = 2 and sc.CargoID = 41) or (sc.CargoTypeID = 7 and sc.CargoID = 18) then sc.Amount else 0 end) as LGIAmount
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 11 then sc.Amount else 0 end) as DSTAmount		
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 5 then sc.Amount else 0 end) as ConFacAmount		
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 21 then sc.Amount else 0 end) as MaintFacAmount	
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 25 then sc.Amount else 0 end) as FinCenAmount	
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 8 then sc.Amount else 0 end) as LabAmount	
		,sum(case when sc.CargoTypeID = 7 and sc.CargoID  not in (16,18) then sc.Amount else 0 end) as TradeGoodsAmount	--trade goods that aren't INF or LGI (accounted for above)
		,sum(sc.Amount) as TotalAmount
		
		,mo.PopulationID
		--,mo.*
	FROM
		fct_fleet as f	
	inner JOIN
		fct_ship as s
	on
		s.FleetID = f.FleetID
	inner JOIN
		FCT_ShipCargo as sc
	on
		sc.ShipID = s.ShipID
	inner JOIN
		FCT_MoveOrders as mo
	on
		mo.FleetID = f.FleetID
	AND
	(
		(mo.MoveActionID = 6 AND sc.CargoTypeID = 1) --match unload colonists order to colonist cargo
		or
		(mo.MoveActionID in (96,177,137) AND sc.CargoTypeID in (2,7)) --match unload (installations or trade goods) with corresponding cargo
	)
		
--	inner JOIN
--		FCT_Population as p
--	on
--		p.PopulationID = mo.PopulationID
	WHERE
		--f.CivilianFunction = 2
	--AND
		mo.MoveActionID in (6,96,177,137)
	group by
		mo.PopulationID
) as InboundShipping
on
	InboundShipping.PopulationID = _pop.PopulationID
left JOIN
(
	SELECT
		sum(case when sc.CargoTypeID = 1 then sc.Amount else 0 end) as PopAmount
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 7 then sc.Amount else 0 end) as MineAmount
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 9 then sc.Amount else 0 end) as INFAmount
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 41 then sc.Amount else 0 end) as LGIAmount
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 11 then sc.Amount else 0 end) as DSTAmount		
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 5 then sc.Amount else 0 end) as ConFacAmount		
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 21 then sc.Amount else 0 end) as MaintFacAmount	
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 25 then sc.Amount else 0 end) as FinCenAmount	
		,sum(case when sc.CargoTypeID = 2 and sc.CargoID = 8 then sc.Amount else 0 end) as LabAmount	
		,sum(sc.Amount) as TotalAmount
		
		,mo.PopulationID
		--,mo.*
	FROM
		fct_fleet as f	
	inner JOIN
		fct_ship as s
	on
		s.FleetID = f.FleetID
	inner JOIN
		FCT_ShipCargo as sc
	on
		sc.ShipID = s.ShipID
	inner JOIN
		FCT_MoveOrders as mo
	on
		mo.FleetID = f.FleetID
	AND
	(
		(mo.MoveActionID = 6 AND sc.CargoTypeID = 1) --match unload colonists order to colonist cargo
		or
		(mo.MoveActionID in (96,177) AND sc.CargoTypeID =2) --match unload installations with corresponding cargo
	)
--	inner JOIN
--		FCT_Population as p
--	on
--		p.PopulationID = mo.PopulationID
	WHERE
		--f.CivilianFunction = 2
	--AND
		mo.MoveActionID in (6,96,177)
	AND
		f.FleetName like '% CY%'
	AND
		f.FleetName like '%/yr%'
	group by
		mo.PopulationID
) as InboundCycling
on
	InboundCycling.PopulationID = _pop.PopulationID
left join
(
select 
	ip.RaceID
	,ip.PopulationID
	,ip.Percentage
from	
	FCT_IndustrialProjects as ip
WHERE
	ip.Description = 'Infrastructure'
AND
	ip.Queue = 0
group by ip.RaceID, ip.PopulationID
) as ipInfra
on ipInfra.PopulationID = _pop.PopulationID
left join
(
select 
	ip.RaceID
	,ip.PopulationID
	,ip.Percentage
from	
	FCT_IndustrialProjects as ip
WHERE
	ip.Description = 'Low Gravity Infrastructure'
group by ip.RaceID, ip.PopulationID
) as ipLGI
on ipLGI.PopulationID = _pop.PopulationID
left join
(
select 
	ip.RaceID
	,ip.PopulationID
	,ip.Percentage
from	
	FCT_IndustrialProjects as ip
WHERE
	ip.Description like 'Forced Labour%'
group by ip.RaceID, ip.PopulationID
) as ipCamps
on ipCamps.PopulationID = _pop.PopulationID
left join
(
select 
	ip.RaceID
	,ip.PopulationID
	,ip.Percentage
from	
	FCT_IndustrialProjects as ip
WHERE
	ip.Description like 'Construction Factory%'
group by ip.RaceID, ip.PopulationID
) as ipConFacs
on ipConFacs.PopulationID = _pop.PopulationID
left JOIN
(
	SELECT
		f.AssignedPopulationID
		,sum(
			CASE
				when sc.Commercial = 0 then sc.Cost
				else 0
			END
		) as TotalShipCost
		,sum(
			CASE
				WHEN sc.SupplyShip = 1 then s.CurrentMaintSupplies - sc.MinimumSupplies 
				ELSE 0
				END
		) as SupplyShipMSPAvailable
	FROM
		FCT_Fleet as f
	inner join
		FCT_Ship as s
	on
		s.FleetID = f.FleetID
	inner JOIN
		FCT_ShipClass as sc
	on
		sc.ShipClassID = s.ShipClassID
	group by
		f.AssignedPopulationID
) as ShipCosts
on ShipCosts.AssignedPopulationID = _pop.PopulationID

left JOIN
	vw_GovernorSectorBonus as gsb
on
	gsb.PopulationID = _pop.PopulationID
order by
	_pop.Population desc;
DROP VIEW IF EXISTS "vw_shipClasses";
CREATE VIEW vw_shipClasses as

select 
	scl.ShipClassID 
	,scl.ClassName
	,scl.RankRequired
	,scl.Commercial as IsCommercial
	,scl.Size
	,scl.Cost
	,ifnull(ShipCounts.ShipCount,0) as ShipCount
	,sum(cc.NumComponent * (sdc.Duranium + sdc.Neutronium + sdc.Corbomite + sdc.Tritanium + sdc.Boronide + sdc.Mercassium + sdc.Vendarite + sdc.Sorium + sdc.Uridium + sdc.Corundium + sdc.Gallicite))	as ClassMinerals
	,sum(cc.NumComponent *Duranium) as           Duranium
	,sum(cc.NumComponent *Neutronium ) as        Neutronium
	,sum(cc.NumComponent *Corbomite  ) as        Corbomite
	,sum(cc.NumComponent *Tritanium ) as         Tritanium
	,sum(cc.NumComponent *Boronide  ) as         Boronide 
	,sum(cc.NumComponent *Mercassium  ) as       Mercassium
	,sum(cc.NumComponent *Vendarite ) as         Vendarite
	,sum(cc.NumComponent *Sorium ) as            Sorium 
	,sum(cc.NumComponent *Uridium ) as           Uridium
	,sum(cc.NumComponent *Corundium) as          Corundium
	,sum(cc.NumComponent *Gallicite) as          Gallicite 
	,scl.MaintSupplies
	,scl.FuelCapacity
	,scl.CommanderPriority
	,scl.ClassShippingLineID
from 
	FCT_ShipClass as scl
inner JOIN
	(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as race
on	
	race.RaceID = scl.RaceID
inner JOIN
	FCT_ClassComponent as cc
on
	cc.ClassID = scl.ShipClassID
inner JOIN
	FCT_ShipDesignComponents as sdc
on
	sdc.SDComponentID = cc.ComponentID
left JOIN
(
	SELECT
		s.ShipClassID
		,count(*) as ShipCount
	FROM
		FCT_Ship as s
	group by
		s.ShipClassID
) as ShipCounts
on
	ShipCounts.ShipClassID = scl.ShipClassID
group by
	scl.ShipClassID;
DROP VIEW IF EXISTS "vw_sorharv";
CREATE VIEW vw_sorharv as


SELECT
	p.PopName
	,upper(substr(rss.Name,1,3)) as Sys
	,sysbodname.Name as BodyName
	,s.ShipName
	,sc.Harvesters
	,ifnull(c.Name,'') as Commander
	,ifnull(cb.BonusValue,1.0) as Bonus
	,ifnull(fm.Accessibility,0) as SorAcc
	,ifnull(fm.Amount/1000,'') as SorAmtK
	--, r.FuelProduction * sc.Harvesters as ShipProduction, sc.*,c.*
FROM
	(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace
inner JOIN
	FCT_Race as r
on
	r.RaceID = CurrentRace.RaceID
inner JOIN
	FCT_Ship as s
on
	s.RaceID = CurrentRace.RaceID
inner JOIN
	FCT_Fleet as f
on
	f.FleetID = s.FleetID
left JOIN
	FCT_SystemBody as sysbod
on
	sysbod.SystemBodyID = f.OrbitBodyID
left JOIN
	FCT_SystemBodyName as sysbodname
on
	sysbodname.SystemBodyID = f.OrbitBodyID
AND
	sysbodname.RaceID = r.RaceID
left JOIN
	FCT_Population as p
on
	p.SystemBodyID = sysbod.SystemBodyID
left join
	FCT_RaceSysSurvey as rss
on
	rss.SystemID = sysbod.SystemID
AND
	rss.RaceID = CurrentRace.RaceID
left JOIN
	FCT_MineralDeposit as fm
on
	fm.SystemBodyID = f.OrbitBodyID
AND
	fm.MaterialID = 8 --sorium
inner JOIN
	FCT_ShipClass as sc
on
	sc.ShipClassID = s.ShipClassID
left JOIN
	FCT_Commander as c
on
	c.CommandID = s.ShipID
AND
	c.CommanderType = 0
AND
	c.CommandType = 1
AND
	c.RaceID = CurrentRace.RaceID
left JOIN
	FCT_CommanderBonuses as cb
on
	cb.CommanderID = c.CommanderID
AND
	cb.BonusID = 6 --mining bonus	
where 
	sc.Harvesters > 0
AND	
	sc.ClassShippingLineID = 0	
order by 
	sc.Harvesters desc
	,ifnull(cb.BonusValue,1.0) desc;
DROP VIEW IF EXISTS "vw_ComponentStockpiles";
CREATE VIEW vw_ComponentStockpiles as 

WITH const AS (SELECT
	(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as raceID
	
)

SELECT
	p.PopName
	, sdc.Name
	, pc.Amount
	--, pc.*, sdc.*
FROM
	FCT_PopComponent as pc
inner JOIN
	FCT_Population as p
on
	p.PopulationID = pc.PopulationID
inner JOIN
	const as c
on
	c.RaceID = p.RaceID
inner JOIN
	FCT_ShipDesignComponents as sdc
on
	sdc.SDComponentID = pc.ComponentID;
DROP VIEW IF EXISTS "vw_BodyName";
CREATE VIEW vw_BodyName as 

SELECT
	sys.RaceID
	,sys.SystemID
	,sb.SystemBodyID
	,upper(substr(sys.Name,1,3)) as SysName
	,upper(substr(sys.Name,1,3)) 
		|| '-' 
		|| CASE 
			WHEN str.Component = 1 then 'A'
			WHEN str.Component = 2 then 'B'	
			WHEN str.Component = 3 then 'C'	
			WHEN str.Component = 4 then 'D'	
			WHEN str.Component = 5 then 'E'	
			WHEN str.Component = 6 then 'F'	
			ELSE 'ZZZZZZZ'
		END	
		|| CASE 
			WHEN sb.BodyTypeID = 1 THEN 'Ast' || sb.OrbitNumber
			WHEN sb.BodyTypeID = 14 THEN 'Com' || sb.OrbitNumber
			WHEN sb.ParentBodyType = 0 then (sb.PlanetNumber)			
			ELSE (sb.PlanetNumber || 'M' || sb.OrbitNumber)
		END
	as BodyName
FROM
(
	select max(RaceID) as RaceID from FCT_Race where NPR = 0
) as Race
inner JOIN
	FCT_RaceSysSurvey as sys
on 
	sys.RaceID = Race.RaceID
inner JOIN
	FCT_SystemBody as sb
on
	sb.SystemID  = sys.SystemID
left JOIN
	FCT_SystemBody as sb_parent
on
	sb_parent.SystemBodyID = sb.ParentBodyID
inner JOIN
	FCT_Star as str
on
	str.StarID = ifnull(sb_parent.ParentBodyID,sb.ParentBodyID)
or
(
	 --special case for Sol
	 --default bodies in Sol (i.e. not Minerva) have a ParentBodyID of 0
	 --since we know that Sol is a single-star system, we can just take the star that matches the SystemID
	ifnull(sb_parent.ParentBodyID,sb.ParentBodyID) = 0
	AND
	str.SystemID = sys.SystemID
)

		/*	*/;
DROP VIEW IF EXISTS "vw_mining_surface";
CREATE VIEW vw_mining_surface as 
--select * from FCT_Race where NPR = 0

SELECT
	surface.Sys
	,surface.PopName
	,b.BodyName as BasicPopName
	,Surface.IsOwned
	, surface.MaterialID
	, surface.MineType
	, surface.MineCount 
	, surface.MineProduction
	, surface.GovBonus 
	, surface.SectorBonus 
	
	, surface.Accessibility 
	, surface.MineCount * surface.MineProduction * surface.GovBonus * surface.SectorBonus * surface.Accessibility as MiningRate
	, round(surface.Amount/1000,1) as AmountK
	, surface.MassDriverDest
	--, *
FROM
(
	SELECT
		upper(substr(_rss.Name,1,3)) as Sys
		,sysbod.SystemBodyID
		,_pop.PopulationID
		,_pop.PopName
		,_pop.MassDriverDest
		,CASE when dpi.Name = 'Civilian Mining Complex' and _pop.PurchaseCivilianMinerals = 0 then 0 else 1 end as IsOwned
		,fm.MaterialID
		,fm.Amount
		,fm.Accessibility
		,fm.HalfOriginalAmount
		,fm.OriginalAcc
		,_pgov.Name as Governor
		,dpi.Name as MineType
		,_race.MineProduction
		,_pi.Amount * CASE WHEN _pi.PlanetaryInstallationID = 39 THEN 10 else 1 end as MineCount
		--,_pgov.CommandType --4 = sector, 3 = governor
		,_pgov.Name as Governor
		,ifnull(_pgovbon.BonusValue,1.0) as GovBonus
		,_sgov.Name as SectorLeader
		,ifnull(1+(_sgovbon.BonusValue-1)/4,1.0) as SectorBonus
		--,_pgovbon.*
	FROM
		FCT_MineralDeposit as fm
	inner JOIN
		FCT_SystemBody as sysbod
	on
		sysbod.SystemBodyID = fm.SystemBodyID
	inner JOIN
		FCT_Population as _pop
	on
		_pop.SystemBodyID = fm.SystemBodyID
	inner JOIN
		(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace
	on
		CurrentRace.RaceID = _pop.RaceID
	inner JOIN
		FCT_Race as _race
	on
		_race.RaceID = _pop.RaceID
	inner JOIN
		FCT_PopulationInstallations as _pi
	on
		_pi.PopID = _pop.PopulationID
	inner JOIN
		DIM_PlanetaryInstallation as dpi
	on
		dpi.PlanetaryInstallationID = _pi.PlanetaryInstallationID
		left JOIN
			FCT_Commander as _pgov
		on
			_pgov.PopLocationID = _pop.PopulationID
		AND
			_pgov.CommanderType = 2 --civilian admin
		AND
			_pgov.CommandType = 3 --governor
		left JOIN
			FCT_CommanderBonuses as _pgovbon
		on
			_pgovbon.CommanderID = _pgov.CommanderID
		AND
			_pgovbon.BonusID = 6 --mining bonus
		left JOIN
			FCT_RaceSysSurvey as _rss
		on
			_rss.RaceID = _race.RaceID
		AND
			_rss.SystemID = _pop.SystemID
		left JOIN
			FCT_SectorCommand as _seccom
		on
			_seccom.SectorCommandID = _rss.SectorID
		left JOIN
			FCT_Commander as _sgov
		on
			_sgov.CommandID = _seccom.SectorCommandID
		AND
			_sgov.CommanderType = 2 --civilian admin
		AND
			_sgov.CommandType = 4 --Sector
		left JOIN
			FCT_CommanderBonuses as _sgovbon
		on
			_sgovbon.CommanderID = _sgov.CommanderID
		AND
			_sgovbon.BonusID = 6 --mining bonus
	WHERE
		dpi.Name in ('Mine','Automated Mine','Civilian Mining Complex','Forced Labour Mining Camp')
	AND
		_pi.Amount > 0
) as surface
inner JOIN
	vw_popname as pn
on
	pn.PopulationID = surface.PopulationID
inner JOIN
	vw_BodyName as b
on
	b.SystemBodyID = surface.SystemBodyID

order by	surface.PopName	,surface.MaterialID;
DROP VIEW IF EXISTS "vw_orbitalMining";
CREATE VIEW vw_orbitalMining as

with x as ( 
	select max(RaceID) as RaceID from FCT_Race where NPR = 0
),
CTE_AdminCommands as 
(
	select 
		nac.RaceID
		,*		
		,nact.Industrial as AdminPct
		,ifnull(cmdrbon.BonusValue,0.0) as CmdrBonus
		,1+(nact.Industrial * (ifnull(cmdrbon.BonusValue,1.0)-1)) as NetBonus		
	--select *
	FROM
		FCT_NavalAdminCommand as nac
	inner JOIN (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as x on	x.RaceID = nac.RaceID
	left JOIN
		FCT_Commander as cmdr
	on
		cmdr.CommandID = nac.NavalAdminCommandID
	AND
		cmdr.CommandType = 12
	left JOIN
		FCT_CommanderBonuses as cmdrbon
	on
		cmdrbon.CommanderID = cmdr.CommanderID
	AND
		cmdrbon.BonusID = 6
	inner JOIN
		DIM_NavalAdminCommandType as nact
	on
		nact.CommandTypeID = nac.AdminCommandTypeID
),
CTE_MiningAdminBonus as
(
	SELECT
		nac.AdminCommandName
		,nac.NavalAdminCommandID
		,nac.NetBonus * ifnull(p_1.NetBonus,1.0) * ifnull(p_2.NetBonus,1.0) * ifnull(p_3.NetBonus,1.0) * ifnull(p_4.NetBonus,1.0) * ifnull(p_5.NetBonus,1.0) * ifnull(p_6.NetBonus,1.0) * ifnull(p_7.NetBonus,1.0) as TotalBonus 
	FROM
		CTE_AdminCommands as nac	
	inner JOIN x on	x.RaceID = nac.RaceID
	left JOIN
		CTE_AdminCommands as p_1
	on
		p_1.NavalAdminCommandID = nac.ParentAdminCommandID 
	left JOIN
		CTE_AdminCommands as p_2
	on
		p_2.NavalAdminCommandID = p_1.ParentAdminCommandID 
	left JOIN
		CTE_AdminCommands as p_3
	on
		p_3.NavalAdminCommandID = p_2.ParentAdminCommandID
	left JOIN
		CTE_AdminCommands as p_4
	on
		p_4.NavalAdminCommandID = p_3.ParentAdminCommandID
	left JOIN
		CTE_AdminCommands as p_5
	on
		p_5.NavalAdminCommandID = p_4.ParentAdminCommandID
	left JOIN
		CTE_AdminCommands as p_6
	on
		p_6.NavalAdminCommandID = p_5.ParentAdminCommandID
	left JOIN
		CTE_AdminCommands as p_7
	on
		p_7.NavalAdminCommandID = p_6.ParentAdminCommandID
),

CTE_ODF as
(
	SELECT
		f.OrbitBodyID
		,f.FleetName
	FROM
		FCT_Fleet as f
	inner JOIN x on	x.RaceID = f.RaceID
	WHERE
		f.FleetName like '___ODF%'
),

CTE_ScoutFleet as
(
	SELECT
		f.OrbitBodyID
		,f.FleetName
	FROM
		FCT_Fleet as f
	--inner JOIN x on	x.RaceID = f.RaceID
	WHERE
		f.FleetName like '___SCOUT%'
),

CTE_STO as
(
	SELECT
		form.PopulationID
		,sum(class.Size) as STOTons
	FROM
		FCT_GroundUnitFormation as form
	--inner JOIN x on	x.RaceID = f.RaceID
	inner JOIN
		FCT_GroundUnitFormationElement as formelem
	on
		formelem.FormationID = form.FormationID
	inner JOIN
		FCT_GroundUnitClass as class
	on
		class.GroundUnitClassID = formelem.ClassID
	WHERE
		class.ClassName like 'STO%'
	group by
		form.PopulationID
)

SELECT
	orbital.Sys
	,orbital.BodyName
	, orbital.MaterialID
	, orbital.MiningModules * orbital.MineProduction * orbital.CmdrBonus * orbital.Accessibility * orbital.AdminBonus as MiningRate
	, orbital.FleetName
	, orbital.ShipName
	, orbital.MiningModules
	, orbital.MineProduction
	, orbital.CmdrBonus
	, orbital.AdminBonus
	, orbital.Accessibility
	, round(orbital.Amount/1000,1) as AmountK
	,ODF
	,ScoutFleet
	,STOTons
	--debugging
	/*
	,orbital.Radius 
	,orbital.MaximumOrbitalMiningDiameter
	,surface.MineCount 
	, surface.MineType
	, surface.MineProduction
	, surface.GovBonus 
	, surface.SectorBonus 
	, surface.MaterialID
	, surface.Accessibility 
	, surface.MineCount * surface.MineProduction * surface.GovBonus * surface.SectorBonus * surface.Accessibility as MiningRate
	, *
	*/
	--*
FROM
(
	SELECT
		upper(substr(_rss.Name,1,3)) as Sys
		,pop.PopName as BodyName
		,fm.MaterialID
		,fm.Amount
		,fm.Accessibility
		,fm.HalfOriginalAmount
		,fm.OriginalAcc
		,_race.MineProduction
		,_flt.FleetName
		,_ship.ShipName
		,_class.MiningModules
		,_cmdr.Name as CommanderName
		,ifnull(_cmdrbon.BonusValue,1.0) as CmdrBonus
		,adm.TotalBonus as AdminBonus
		,ifnull(CTE_ODF.FleetName,'') as ODF
		,ifnull(CTE_ScoutFleet.FleetName,'') as ScoutFleet
		,ifnull(CTE_STO.STOTons,0) as STOTons
		
		--debugging
		,sysbod.Radius 
		,_race.MaximumOrbitalMiningDiameter
		
		--,_pgov.CommandType --4 = sector, 3 = governor
		--,_pgovbon.*
		--,_class.*
		--,_flt.*
		--,_cmdr.*
		--,x.*
-- select *		
	FROM
		FCT_MineralDeposit as fm
	inner JOIN
		FCT_SystemBody as sysbod
	on
		sysbod.SystemBodyID = fm.SystemBodyID
	inner JOIN
		FCT_Population as Pop
	on
		pop.SystemBodyID = fm.SystemBodyID
	inner JOIN x on	x.RaceID = Pop.RaceID
	inner JOIN
		FCT_Fleet as _flt
	on
		_flt.OrbitBodyID = sysbod.SystemBodyID
	inner JOIN
		FCT_Race as _race
	on
		_race.RaceID = _flt.RaceID
	inner JOIN
		FCT_Ship as _ship
	on
		_ship.FleetID = _flt.FleetID
	inner JOIN
		FCT_ShipClass as _class
	on
		_class.ShipClassID = _ship.ShipClassID
	left JOIN
		FCT_Commander as _cmdr
	on
		_cmdr.CommandID = _ship.ShipID
	AND
		_cmdr.CommanderType = 0
	left JOIN
		FCT_CommanderBonuses as _cmdrbon
	on
		_cmdrbon.CommanderID = _cmdr.CommanderID
	AND
		_cmdrbon.BonusID = 6 --mining bonus
	inner JOIN
		CTE_MiningAdminBonus as adm
	on
		adm.NavalAdminCommandID = _flt.ParentCommandID	
	left JOIN
		FCT_RaceSysSurvey as _rss
	on
		_rss.RaceID = _race.RaceID
	AND
		_rss.SystemID = sysbod.SystemID
	left JOIN
		CTE_ODF
	on
		CTE_ODF.OrbitBodyID = sysbod.SystemBodyID
	left JOIN
		CTE_ScoutFleet
	on
		CTE_ScoutFleet.OrbitBodyID = sysbod.SystemBodyID
	left JOIN
		CTE_STO
	on
		CTE_STO.PopulationID = Pop.PopulationID
	WHERE
		_race.NPR = 0
	AND
		_class.MiningModules > 0
	AND
		sysbod.Radius * 2 <= _race.MaximumOrbitalMiningDiameter
) as orbital	
/*
group by
	orbital.BodyName
	,orbital.MaterialID
*/;
DROP VIEW IF EXISTS "vw_survey";
CREATE VIEW vw_survey as 
with CTE_Const as 
(
	select max(RaceID) as RaceID from FCT_Race where NPR = 0
)

SELECT
	substr(rss.Name,1,3) as Sys
	,sys.JumpPointSurveyPoints as PtsPerLoc
	,30-IFNULL(LocationsDone.cnt,0) as UnexLocs	
	,'' as AssignedFleets
	,IFNULL(InProgress.cnt,0) as InProgressLocs
	,IFNULL(InProgress.PointsRemaining,0) as InProgressPointsRemaining
	--,*
FROM
	FCT_RaceSysSurvey as rss
inner join
	CTE_Const
on
	CTE_Const.RaceID = rss.RaceID
inner JOIN
	FCT_System as sys
on
	sys.SystemID = rss.SystemID
left JOIN
(
SELECT
	rsl.SystemID
	,rsl.RaceID
	,count(*) as cnt
from
	FCT_RaceSurveyLocation as rsl
group by
	rsl.SystemID ,rsl.RaceID
) as LocationsDone
on
	rss.RaceID = LocationsDone.RaceID
AND
	rss.SystemID = LocationsDone.SystemID
left JOIN
(
	SELECT
		mo.RaceID
		,mo.StartSystemID as SystemID
		,count(*) as cnt
		,sum(mo.SurveyPointsRequired) as PointsRemaining
	FROM
		FCT_MoveOrders as mo
	inner join
	(
		SELECT
			mo.FleetID
			,MIN(mo.MoveOrderID) as MoveOrderID			
		FROM
			FCT_MoveOrders as mo
		group by
			mo.FleetID
	) as firstOrder
	on
		firstOrder.MoveOrderID = mo.MoveOrderID
	WHERE
		mo.DestinationType = 4
	group by
		mo.RaceID
		,mo.StartSystemID
) as InProgress
on
	InProgress.RaceID = rss.RaceID
AND
	InProgress.SystemID = rss.SystemID;
COMMIT;
